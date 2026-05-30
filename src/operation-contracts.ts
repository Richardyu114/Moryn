import { actionExecution, actionSafety, type ActionExecution, type ActionSafety } from "./core/action-safety.js";
import { commandLineForCliInterface } from "./core/cli-command-line.js";
import { SYNC_MODES } from "./core/project.js";
import {
  RECORD_KINDS,
  RECORD_PRIORITIES,
  RECORD_SCOPES,
  RECORD_STATES
} from "./core/schema.js";
import { requiredFieldsByName, type RequiredFieldMetadata } from "./core/workflow.js";

type OperationCategory = "setup" | "core" | "sync" | "lifecycle" | "contracts" | "maintenance";

type OperationInterfaces = {
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

type OperationInterfacesInput = {
  cli: {
    command: string;
    argv: string[];
  };
  mcp: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

export type OperationContract = {
  operation: string;
  category: OperationCategory;
  summary: string;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  required_fields_by_name: Record<string, OperationRequiredFieldMetadata>;
  arguments_by_name: Record<string, OperationArgumentMetadata>;
  argument_sources?: Record<string, string>;
  interfaces: OperationInterfaces;
  safety: ActionSafety;
  execution: ActionExecution;
  selection_sources: Record<string, string>;
};

type OperationRequiredFieldMetadata = RequiredFieldMetadata & {
  alternatives?: string[];
  allowed_values?: readonly string[];
};

export type OperationArgumentType = "string" | "string[]" | "number" | "boolean" | "object";

export type OperationArgumentMetadata = {
  name: string;
  type: OperationArgumentType;
  required: boolean;
  cli?: {
    flag?: string;
    flags?: readonly string[];
    positional?: string;
    repeatable?: boolean;
    default?: unknown;
    negative_flag?: string;
  };
  mcp?: {
    argument: string;
    path?: string;
  };
  default?: unknown;
  allowed_values?: readonly string[];
  alternatives?: readonly string[];
};

type OperationArgumentMetadataInput = Omit<OperationArgumentMetadata, "name"> & {
  name?: string;
};

type OperationContractInput = Omit<OperationContract, "required_fields_by_name" | "arguments_by_name" | "interfaces" | "safety" | "execution" | "selection_sources"> & {
  required_fields_by_name?: Record<string, OperationRequiredFieldMetadata>;
  arguments_by_name?: Record<string, OperationArgumentMetadataInput>;
  interfaces: OperationInterfacesInput;
};

export type SingleOperationContractResponse = {
  operation: OperationContract;
  operation_source: string;
  matched_source: string;
  selection_sources: typeof OPERATION_CONTRACTS_SELECTION_SOURCES;
};

export type OperationContractIndexEntry = {
  operation: string;
  category: OperationCategory;
  summary: string;
  safe_to_run: boolean;
  ready_to_run: boolean;
  next_step: string;
  mcp_tool: string;
  cli_command: string;
  required_fields: string[];
  missing_required_fields: string[];
  execution_hint: {
    guard: "execution.ready_to_run";
    ready_to_run: boolean;
    next_step: ActionExecution["next_step"];
    required_fields: string[];
    missing_required_fields: string[];
    required_input_sources: {
      by_field: "execution.required_inputs_by_field.<field>";
      by_argument_path: "execution.required_inputs_by_argument_path.<argument_path>";
    };
  };
  full_contract_lookup: {
    package_helper: string;
    cli: {
      command: string;
      executable: "moryn";
      args: string[];
      exec_file: {
        executable: "moryn";
        args: string[];
      };
    };
    mcp: {
      tool: "operation_contracts";
      arguments: { operation: string };
    };
  };
};

export type OperationContractIndexResponse = {
  recommended_entrypoint: string;
  index_use: string;
  next_lookup: {
    package_helpers: {
      by_operation: string;
      by_mcp_tool: string;
      by_cli_command: string;
    };
    cli: {
      by_operation: string;
      by_mcp_tool: string;
      by_cli_command: string;
    };
    mcp: {
      tool: string;
      by_operation_arguments: { operation: string };
      by_mcp_tool_arguments: { mcp_tool: string };
      by_cli_command_arguments: { cli_command: string };
    };
  };
  operations: OperationContractIndexEntry[];
  operations_by_id: Record<string, OperationContractIndexEntry>;
  operations_by_mcp_tool: Record<string, string>;
  operations_by_cli_command: Record<string, string>;
  selection_sources: Pick<
    typeof OPERATION_CONTRACTS_SELECTION_SOURCES,
    "operation" | "mcp_tool_operation" | "cli_command_operation" | "ordered_operation"
  >;
};

export const OPERATION_CONTRACTS_SELECTION_SOURCES = {
  operation: "operations_by_id.<operation>",
  operation_id: "operations_by_id.<operation>.operation",
  category: "operations_by_category.<category>",
  category_operation: "operations_by_category.<category>.<operation>",
  mcp_tool_operation: "operations_by_mcp_tool.<tool>",
  cli_command_operation: "operations_by_cli_command.<command>",
  required_field: "operations_by_id.<operation>.required_fields_by_name.<field>",
  allowed_value: "operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]",
  required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
  required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>",
  required_input_path_by_value_path: "operations_by_id.<operation>.execution.required_input_paths_by_value_path.<value_path>",
  argument: "operations_by_id.<operation>.arguments_by_name.<argument>",
  argument_allowed_value: "operations_by_id.<operation>.arguments_by_name.<argument>.allowed_values[]",
  argument_source: "operations_by_id.<operation>.argument_sources.<field>",
  cli_command: "operations_by_id.<operation>.interfaces.cli.command",
  cli_command_line: "operations_by_id.<operation>.interfaces.cli.command_line",
  cli_argv: "operations_by_id.<operation>.interfaces.cli.argv[]",
  cli_executable: "operations_by_id.<operation>.interfaces.cli.executable",
  cli_args: "operations_by_id.<operation>.interfaces.cli.args[]",
  cli_exec_file: "operations_by_id.<operation>.interfaces.cli.exec_file",
  cli_placeholder: "operations_by_id.<operation>.interfaces.cli.placeholders[]",
  mcp_tool: "operations_by_id.<operation>.interfaces.mcp.tool",
  ordered_operation: "operations[]"
} as const;

const OPERATION_LOCAL_SELECTION_SOURCES = Object.fromEntries(
  Object.entries(OPERATION_CONTRACTS_SELECTION_SOURCES).filter(([key]) => ![
    "category",
    "category_operation",
    "mcp_tool_operation",
    "cli_command_operation",
    "required_input_path_by_value_path",
    "ordered_operation"
  ].includes(key))
) as Omit<typeof OPERATION_CONTRACTS_SELECTION_SOURCES, "required_input_path_by_value_path">;

function userInputSources(fields: readonly string[]): Record<string, string> | undefined {
  return fields.length ? Object.fromEntries(fields.map((field) => [field, `user_input.${field}`])) : undefined;
}

function operationRequiredFieldsByName(input: OperationContractInput): Record<string, OperationRequiredFieldMetadata> {
  return {
    ...requiredFieldsByName(input.required_fields, input.interfaces.mcp.arguments),
    ...input.required_fields_by_name
  };
}

function operationArgumentsByName(input: OperationContractInput): Record<string, OperationArgumentMetadata> {
  return Object.fromEntries(Object.entries(input.arguments_by_name ?? {}).map(([name, metadata]) => [
    name,
    { ...metadata, name }
  ]));
}

function requiredInputSelectionSources(selectionSources: Record<string, string>): Record<string, string> | undefined {
  const sources = Object.fromEntries(Object.entries(selectionSources).filter(([key]) =>
    key === "required_input" || key === "required_input_argument_path"
  ));
  return Object.keys(sources).length > 0 ? sources : undefined;
}

function cliPlaceholders(argv: readonly string[]): string[] {
  return Array.from(new Set(argv.flatMap((arg) => {
    const match = /^<([^<>]+)>$/.exec(arg);
    return match ? [match[1]!] : [];
  })));
}

function operationContract(input: OperationContractInput): OperationContract {
  const required_fields_by_name = operationRequiredFieldsByName(input);
  const arguments_by_name = operationArgumentsByName(input);
  const placeholders = cliPlaceholders(input.interfaces.cli.argv);
  const interfaces = {
    ...input.interfaces,
    cli: {
      ...input.interfaces.cli,
      executable: "moryn",
      args: input.interfaces.cli.argv,
      exec_file: {
        executable: "moryn",
        args: input.interfaces.cli.argv
      },
      placeholders,
      has_placeholders: placeholders.length > 0,
      command_line: commandLineForCliInterface("moryn", input.interfaces.cli.argv)
    }
  };
  return {
    ...input,
    interfaces,
    required_fields_by_name,
    arguments_by_name,
    ...(input.argument_sources ? { argument_sources: input.argument_sources } : {}),
    safety: actionSafety({
      tool: interfaces.mcp.tool,
      safe_to_run: input.safe_to_run,
      required_fields: input.required_fields
    }),
    execution: actionExecution({
      tool: interfaces.mcp.tool,
      safe_to_run: input.safe_to_run,
      required_fields: input.required_fields,
      required_fields_by_name,
      arguments_by_name,
      argument_sources: input.argument_sources,
      required_input_selection_sources: requiredInputSelectionSources(OPERATION_CONTRACTS_SELECTION_SOURCES)
    }),
    selection_sources: OPERATION_LOCAL_SELECTION_SOURCES
  };
}

const agentSourceArgument = {
  agent: {
    type: "object",
    required: false,
    cli: { flags: ["--agent", "--session-id", "--model", "--device-id"] },
    mcp: { argument: "agent" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const projectContextArguments = {
  project_id: {
    type: "string",
    required: false,
    cli: { flag: "--project-id" },
    mcp: { argument: "project_id" }
  },
  project_path: {
    type: "string",
    required: false,
    cli: { flag: "--project" },
    mcp: { argument: "project_path" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const lifecycleContextArguments = {
  ...projectContextArguments,
  sync_remote: {
    type: "string",
    required: false,
    cli: { flag: "--sync-remote" },
    mcp: { argument: "sync_remote" }
  },
  current_task: {
    type: "string",
    required: false,
    cli: { flag: "--current-task" },
    mcp: { argument: "current_task" }
  },
  ...agentSourceArgument
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const startSessionArguments = {
  ...lifecycleContextArguments,
  refresh_since: {
    type: "string",
    required: false,
    cli: { flag: "--refresh-since" },
    mcp: { argument: "refresh_since" }
  },
  limit: {
    type: "number",
    required: false,
    default: 20,
    cli: { flag: "--limit", default: 20 },
    mcp: { argument: "limit" }
  },
  pull: {
    type: "boolean",
    required: false,
    default: true,
    cli: { negative_flag: "--no-pull" },
    mcp: { argument: "pull" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const publishSessionArguments = {
  ...lifecycleContextArguments,
  push: {
    type: "boolean",
    required: false,
    default: true,
    cli: { negative_flag: "--no-push" },
    mcp: { argument: "push" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

export const OPERATION_CONTRACTS = [
  operationContract({
    operation: "agent_enter",
    category: "lifecycle",
    summary: "Recommended startup entrypoint; diagnoses setup, discovers projects, or starts a known project session.",
    safe_to_run: true,
    required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
    required_fields: [],
    arguments_by_name: startSessionArguments,
    interfaces: {
      cli: { command: "moryn agent enter", argv: ["agent", "enter"] },
      mcp: { tool: "agent_enter", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_guide",
    category: "lifecycle",
    summary: "Return static lifecycle guidance, guardrails, workflow, CLI commands, and MCP arguments.",
    safe_to_run: true,
    required_when: "When an agent host needs the lifecycle contract before choosing runtime actions.",
    required_fields: [],
    arguments_by_name: lifecycleContextArguments,
    interfaces: {
      cli: { command: "moryn agent guide", argv: ["agent", "guide"] },
      mcp: { tool: "agent_guide", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_doctor",
    category: "lifecycle",
    summary: "Diagnose store, project, and sync readiness and return the next safe setup/start action.",
    safe_to_run: true,
    required_when: "When setup may be missing or broken and the agent needs a read-only readiness check.",
    required_fields: [],
    arguments_by_name: lifecycleContextArguments,
    interfaces: {
      cli: { command: "moryn agent doctor", argv: ["agent", "doctor"] },
      mcp: { tool: "agent_doctor", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_start",
    category: "lifecycle",
    summary: "Resolve project context, pull sync when appropriate, boot context, refresh changes, and return next actions.",
    safe_to_run: true,
    required_when: "After project context is known, or when following agent_enter/agent_guide startup actions.",
    required_fields: [],
    arguments_by_name: startSessionArguments,
    interfaces: {
      cli: { command: "moryn agent start", argv: ["agent", "start"] },
      mcp: { tool: "agent_start", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_status",
    category: "lifecycle",
    summary: "Write an in-progress project status checkpoint for handoff and coordination.",
    safe_to_run: false,
    required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
    required_fields: ["status"],
    argument_sources: userInputSources(["status"]),
    arguments_by_name: {
      status: {
        type: "string",
        required: true,
        cli: { flag: "--status" },
        mcp: { argument: "status" }
      },
      ...publishSessionArguments
    },
    interfaces: {
      cli: { command: "moryn agent status --status <status>", argv: ["agent", "status", "--status", "<status>"] },
      mcp: { tool: "agent_status", arguments: { status: "<status>" } }
    }
  }),
  operationContract({
    operation: "agent_finish",
    category: "lifecycle",
    summary: "Write a final session summary and push sync when appropriate.",
    safe_to_run: false,
    required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
    required_fields: ["summary"],
    argument_sources: userInputSources(["summary"]),
    arguments_by_name: {
      summary: {
        type: "string",
        required: true,
        cli: { flag: "--summary" },
        mcp: { argument: "summary" }
      },
      ...publishSessionArguments
    },
    interfaces: {
      cli: { command: "moryn agent finish --summary <summary>", argv: ["agent", "finish", "--summary", "<summary>"] },
      mcp: { tool: "agent_finish", arguments: { summary: "<summary>" } }
    }
  }),
  operationContract({
    operation: "selection_source_contracts",
    category: "contracts",
    summary: "Return stable response field-path contracts grouped by setup, core, sync, lifecycle, and recovery.",
    safe_to_run: true,
    required_when: "When an agent needs canonical JSON paths instead of guessing response field names.",
    required_fields: [],
    interfaces: {
      cli: { command: "moryn contracts selection-sources", argv: ["contracts", "selection-sources"] },
      mcp: { tool: "selection_source_contracts", arguments: {} }
    }
  }),
  operationContract({
    operation: "operation_contracts",
    category: "contracts",
    summary: "Return this operation registry with CLI/MCP interfaces, safety, and required fields.",
    safe_to_run: true,
    required_when: "When an agent needs to discover available Moryn operations without reading docs.",
    required_fields: [],
    arguments_by_name: {
      index: {
        type: "boolean",
        required: false,
        cli: { flag: "--index" },
        mcp: { argument: "index" }
      },
      operation: {
        type: "string",
        required: false,
        cli: { flag: "--operation" },
        mcp: { argument: "operation" }
      },
      mcp_tool: {
        type: "string",
        required: false,
        cli: { flag: "--mcp-tool" },
        mcp: { argument: "mcp_tool" }
      },
      cli_command: {
        type: "string",
        required: false,
        cli: { flag: "--cli-command" },
        mcp: { argument: "cli_command" }
      }
    },
    interfaces: {
      cli: { command: "moryn contracts operations", argv: ["contracts", "operations"] },
      mcp: {
        tool: "operation_contracts",
        arguments: {
          index: true,
          operation: "<operation>",
          mcp_tool: "<tool>",
          cli_command: "<command>"
        }
      }
    }
  }),
  operationContract({
    operation: "init",
    category: "setup",
    summary: "Create or update the local Moryn store configuration and directories.",
    safe_to_run: false,
    required_when: "When the store is missing and the user wants to initialize local memory.",
    required_fields: [],
    arguments_by_name: {
      repair: {
        type: "boolean",
        required: false,
        cli: { flag: "--repair" },
        mcp: { argument: "repair" }
      }
    },
    interfaces: {
      cli: { command: "moryn init", argv: ["init"] },
      mcp: { tool: "init", arguments: {} }
    }
  }),
  operationContract({
    operation: "project_init",
    category: "setup",
    summary: "Create or update a .moryn.json project config.",
    safe_to_run: false,
    required_when: "When a project path has no Moryn config or the project config needs explicit repair.",
    required_fields: ["path"],
    argument_sources: userInputSources(["path"]),
    arguments_by_name: {
      path: {
        type: "string",
        required: true,
        cli: { flag: "--path", default: "." },
        mcp: { argument: "path" }
      },
      project_id: {
        type: "string",
        required: false,
        cli: { flag: "--project-id" },
        mcp: { argument: "project_id" }
      },
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      default_skills: {
        type: "string[]",
        required: false,
        cli: { flag: "--default-skill", repeatable: true },
        mcp: { argument: "default_skills" }
      },
      sync_mode: {
        type: "string",
        required: false,
        cli: { flag: "--sync-mode" },
        mcp: { argument: "sync_mode" },
        allowed_values: SYNC_MODES
      },
      repair: {
        type: "boolean",
        required: false,
        cli: { flag: "--repair" },
        mcp: { argument: "repair" }
      }
    },
    required_fields_by_name: {
      sync_mode: {
        name: "sync_mode",
        argument_path: "sync_mode",
        allowed_values: SYNC_MODES
      }
    },
    interfaces: {
      cli: { command: "moryn project init --path <path>", argv: ["project", "init", "--path", "<path>"] },
      mcp: { tool: "project_init", arguments: { path: "<path>" } }
    }
  }),
  operationContract({
    operation: "project_list",
    category: "setup",
    summary: "List known projects and project-specific start actions from the Moryn store.",
    safe_to_run: true,
    required_when: "When project context is unclear and the store may already know one or more projects.",
    required_fields: [],
    arguments_by_name: {
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      sync_remote: {
        type: "string",
        required: false,
        cli: { flag: "--sync-remote" },
        mcp: { argument: "sync_remote" }
      },
      ...agentSourceArgument
    },
    interfaces: {
      cli: { command: "moryn project list", argv: ["project", "list"] },
      mcp: { tool: "project_list", arguments: {} }
    }
  }),
  operationContract({
    operation: "boot",
    category: "core",
    summary: "Return bounded memory, skill, project, and task context for a known project.",
    safe_to_run: true,
    required_when: "When an agent needs context and already knows the target project.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      default_skills: {
        type: "string[]",
        required: false,
        mcp: { argument: "default_skills" }
      },
      sync_remote: {
        type: "string",
        required: false,
        mcp: { argument: "sync_remote" }
      }
    },
    interfaces: {
      cli: { command: "moryn boot", argv: ["boot"] },
      mcp: { tool: "boot", arguments: {} }
    }
  }),
  operationContract({
    operation: "recall",
    category: "core",
    summary: "Search or fetch records by query, record id, project, kind, scope, state, tag, type, or file.",
    safe_to_run: true,
    required_when: "When an agent needs specific memory records or the full content behind a returned record id.",
    required_fields: [],
    arguments_by_name: {
      query: {
        type: "string",
        required: false,
        cli: { positional: "query" },
        mcp: { argument: "query" }
      },
      record_ids: {
        type: "string[]",
        required: false,
        cli: { flag: "--record-id", repeatable: true },
        mcp: { argument: "record_ids" }
      },
      ...projectContextArguments,
      kinds: {
        type: "string[]",
        required: false,
        cli: { flag: "--kind", repeatable: true },
        mcp: { argument: "kinds" },
        allowed_values: RECORD_KINDS
      },
      scopes: {
        type: "string[]",
        required: false,
        cli: { flag: "--scope", repeatable: true },
        mcp: { argument: "scopes" },
        allowed_values: RECORD_SCOPES
      },
      types: {
        type: "string[]",
        required: false,
        cli: { flag: "--type", repeatable: true },
        mcp: { argument: "types" }
      },
      states: {
        type: "string[]",
        required: false,
        cli: { flag: "--state", repeatable: true },
        mcp: { argument: "states" },
        allowed_values: RECORD_STATES
      },
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      files: {
        type: "string[]",
        required: false,
        cli: { flag: "--file", repeatable: true },
        mcp: { argument: "files" }
      },
      limit: {
        type: "number",
        required: false,
        default: 10,
        cli: { flag: "--limit", default: 10 },
        mcp: { argument: "limit" }
      }
    },
    interfaces: {
      cli: { command: "moryn recall", argv: ["recall"] },
      mcp: { tool: "recall", arguments: {} }
    }
  }),
  operationContract({
    operation: "write",
    category: "core",
    summary: "Append a new memory, skill, soul, session summary, or agent note record.",
    safe_to_run: false,
    required_when: "When the agent has authored record content and the target kind/type/scope are known.",
    required_fields: ["kind", "type", "scope", "text_or_content"],
    argument_sources: userInputSources(["kind", "type", "scope", "text_or_content"]),
    arguments_by_name: {
      kind: {
        type: "string",
        required: true,
        cli: { flag: "--kind" },
        mcp: { argument: "kind" },
        allowed_values: RECORD_KINDS
      },
      type: {
        type: "string",
        required: true,
        cli: { flag: "--type" },
        mcp: { argument: "type" }
      },
      scope: {
        type: "string",
        required: true,
        cli: { flag: "--scope" },
        mcp: { argument: "scope" },
        allowed_values: RECORD_SCOPES
      },
      text: {
        type: "string",
        required: false,
        cli: { flag: "--text" },
        mcp: { argument: "text" },
        alternatives: ["content"]
      },
      content: {
        type: "object",
        required: false,
        cli: { flag: "--content-json" },
        mcp: { argument: "content" },
        alternatives: ["text"]
      },
      ...projectContextArguments,
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      state: {
        type: "string",
        required: false,
        cli: { flag: "--state" },
        mcp: { argument: "state" },
        allowed_values: RECORD_STATES
      },
      confidence: {
        type: "number",
        required: false,
        cli: { flag: "--confidence" },
        mcp: { argument: "confidence" }
      },
      priority: {
        type: "string",
        required: false,
        cli: { flag: "--priority" },
        mcp: { argument: "priority" },
        allowed_values: RECORD_PRIORITIES
      },
      derived_from: {
        type: "string[]",
        required: false,
        cli: { flag: "--derived-from", repeatable: true },
        mcp: { argument: "provenance", path: "provenance.derived_from" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "provenance", path: "provenance.reason" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    required_fields_by_name: {
      kind: {
        name: "kind",
        argument_path: "kind",
        value: "<kind>",
        placeholder: "<kind>",
        allowed_values: RECORD_KINDS
      },
      scope: {
        name: "scope",
        argument_path: "scope",
        value: "<scope>",
        placeholder: "<scope>",
        allowed_values: RECORD_SCOPES
      },
      priority: {
        name: "priority",
        argument_path: "priority",
        allowed_values: RECORD_PRIORITIES
      },
      text_or_content: {
        name: "text_or_content",
        argument_path: "text|content",
        placeholder: "<text_or_content>",
        alternatives: ["text", "content"]
      }
    },
    interfaces: {
      cli: {
        command: "moryn write --kind <kind> --type <type> --scope <scope> --text <text>",
        argv: ["write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"]
      },
      mcp: { tool: "write", arguments: { kind: "<kind>", type: "<type>", scope: "<scope>", text: "<text>" } }
    }
  }),
  operationContract({
    operation: "revise",
    category: "core",
    summary: "Append a logical patch event for an existing record.",
    safe_to_run: false,
    required_when: "When an existing record needs a targeted patch and the patch is already known.",
    required_fields: ["record_id", "patch"],
    argument_sources: userInputSources(["record_id", "patch"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      patch: {
        type: "object",
        required: true,
        cli: { flag: "--set", repeatable: true },
        mcp: { argument: "patch" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    interfaces: {
      cli: { command: "moryn revise <record_id> --set <path=value>", argv: ["revise", "<record_id>", "--set", "<path=value>"] },
      mcp: { tool: "revise", arguments: { record_id: "<record_id>", patch: { "<path>": "<value>" } } }
    }
  }),
  operationContract({
    operation: "promote",
    category: "core",
    summary: "Change a record state by appending a promotion/state event.",
    safe_to_run: false,
    required_when: "When a candidate, archived, or quarantined record should move to a target state.",
    required_fields: ["record_id", "target_state"],
    argument_sources: userInputSources(["record_id", "target_state"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      target_state: {
        type: "string",
        required: true,
        cli: { flag: "--state" },
        mcp: { argument: "target_state" },
        allowed_values: RECORD_STATES
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    required_fields_by_name: {
      target_state: {
        name: "target_state",
        argument_path: "target_state",
        value: "<state>",
        placeholder: "<state>",
        allowed_values: RECORD_STATES
      }
    },
    interfaces: {
      cli: { command: "moryn promote <record_id> --state <state>", argv: ["promote", "<record_id>", "--state", "<state>"] },
      mcp: { tool: "promote", arguments: { record_id: "<record_id>", target_state: "<state>" } }
    }
  }),
  operationContract({
    operation: "archive",
    category: "core",
    summary: "Hide a record from default boot and recall while preserving history.",
    safe_to_run: false,
    required_when: "When a record should be removed from normal retrieval without deleting history.",
    required_fields: ["record_id"],
    argument_sources: userInputSources(["record_id"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    interfaces: {
      cli: { command: "moryn archive <record_id>", argv: ["archive", "<record_id>"] },
      mcp: { tool: "archive", arguments: { record_id: "<record_id>" } }
    }
  }),
  operationContract({
    operation: "quarantine",
    category: "core",
    summary: "Mark a record as sensitive or unsafe so it is excluded by default.",
    safe_to_run: false,
    required_when: "When a record should stop appearing in normal agent context because it is unsafe or sensitive.",
    required_fields: ["record_id"],
    argument_sources: userInputSources(["record_id"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    interfaces: {
      cli: { command: "moryn quarantine <record_id>", argv: ["quarantine", "<record_id>"] },
      mcp: { tool: "quarantine", arguments: { record_id: "<record_id>" } }
    }
  }),
  operationContract({
    operation: "link",
    category: "core",
    summary: "Append a relationship from one record to another.",
    safe_to_run: false,
    required_when: "When two existing records should be connected by a known relationship type.",
    required_fields: ["record_id", "linked_record_id", "link_type"],
    argument_sources: userInputSources(["record_id", "linked_record_id", "link_type"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      linked_record_id: {
        type: "string",
        required: true,
        cli: { positional: "linked-record-id" },
        mcp: { argument: "linked_record_id" }
      },
      link_type: {
        type: "string",
        required: true,
        cli: { flag: "--type" },
        mcp: { argument: "link_type" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      }
    },
    interfaces: {
      cli: {
        command: "moryn link <record_id> <linked_record_id> --type <type>",
        argv: ["link", "<record_id>", "<linked_record_id>", "--type", "<type>"]
      },
      mcp: { tool: "link", arguments: { record_id: "<record_id>", linked_record_id: "<linked_record_id>", link_type: "<type>" } }
    }
  }),
  operationContract({
    operation: "list_recent",
    category: "core",
    summary: "Return recently updated records.",
    safe_to_run: true,
    required_when: "When an agent needs a quick recent-record index or a fallback after a missing record id.",
    required_fields: [],
    arguments_by_name: {
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      }
    },
    interfaces: {
      cli: { command: "moryn list-recent", argv: ["list-recent"] },
      mcp: { tool: "list_recent", arguments: {} }
    }
  }),
  operationContract({
    operation: "refresh",
    category: "core",
    summary: "Return important changes since a cursor for periodic memory refresh.",
    safe_to_run: true,
    required_when: "When an agent has a refresh cursor and needs changes without a full boot.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      cursor: {
        type: "string",
        required: false,
        cli: { flag: "--cursor" },
        mcp: { argument: "cursor" }
      },
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      }
    },
    interfaces: {
      cli: { command: "moryn refresh", argv: ["refresh"] },
      mcp: { tool: "refresh", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_init",
    category: "sync",
    summary: "Initialize or connect the local Moryn store to a Git remote.",
    safe_to_run: false,
    required_when: "When cross-device sync is needed and the target remote is known.",
    required_fields: ["remote"],
    argument_sources: userInputSources(["remote"]),
    arguments_by_name: {
      remote: {
        type: "string",
        required: true,
        cli: { positional: "remote" },
        mcp: { argument: "remote" }
      }
    },
    interfaces: {
      cli: { command: "moryn sync init <remote>", argv: ["sync", "init", "<remote>"] },
      mcp: { tool: "sync_init", arguments: { remote: "<remote>" } }
    }
  }),
  operationContract({
    operation: "sync_status",
    category: "sync",
    summary: "Return Git sync configuration and local/remote status.",
    safe_to_run: true,
    required_when: "Before retrying sync operations after a conflict, or when sync readiness is unclear.",
    required_fields: [],
    arguments_by_name: {},
    interfaces: {
      cli: { command: "moryn sync --status", argv: ["sync", "--status"] },
      mcp: { tool: "sync_status", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_pull",
    category: "sync",
    summary: "Pull remote event history into the local Moryn store.",
    safe_to_run: false,
    required_when: "When the user wants a direct pull instead of using agent_start/agent_enter lifecycle sync.",
    required_fields: [],
    arguments_by_name: {},
    interfaces: {
      cli: { command: "moryn sync --pull", argv: ["sync", "--pull"] },
      mcp: { tool: "sync_pull", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_push",
    category: "sync",
    summary: "Commit and push local event history from the Moryn store.",
    safe_to_run: false,
    required_when: "When the user wants a direct push instead of using lifecycle status/finish sync.",
    required_fields: [],
    arguments_by_name: {
      message: {
        type: "string",
        required: false,
        cli: { flag: "--message" },
        mcp: { argument: "message" }
      }
    },
    interfaces: {
      cli: { command: "moryn sync --push", argv: ["sync", "--push"] },
      mcp: { tool: "sync_push", arguments: {} }
    }
  }),
  operationContract({
    operation: "rebuild",
    category: "maintenance",
    summary: "Regenerate snapshots and indexes from append-only events.",
    safe_to_run: true,
    required_when: "When derived views may be stale or after manual event-store recovery.",
    required_fields: [],
    arguments_by_name: {},
    interfaces: {
      cli: { command: "moryn rebuild", argv: ["rebuild"] },
      mcp: { tool: "rebuild", arguments: {} }
    }
  })
] as const satisfies readonly OperationContract[];

function operationsById(operations: readonly OperationContract[]): Record<string, OperationContract> {
  return Object.fromEntries(operations.map((operation) => [operation.operation, operation]));
}

const OPERATION_CONTRACTS_BY_ID = operationsById(OPERATION_CONTRACTS);

const OPERATION_CONTRACTS_BY_TOOL = Object.fromEntries(
  OPERATION_CONTRACTS.map((operation) => [operation.interfaces.mcp.tool, operation])
) as Record<string, OperationContract>;

const OPERATION_CONTRACTS_BY_CLI_COMMAND = Object.fromEntries(
  OPERATION_CONTRACTS.map((operation) => [operation.interfaces.cli.command, operation])
) as Record<string, OperationContract>;

export function operationArgumentsByTool(tool: string): Record<string, OperationArgumentMetadata> {
  return OPERATION_CONTRACTS_BY_TOOL[tool]?.arguments_by_name ?? {};
}

export function operationCliArgvByTool(tool: string): readonly string[] {
  return OPERATION_CONTRACTS_BY_TOOL[tool]?.interfaces.cli.argv ?? tool.split("_");
}

function singleOperationContractResponse(contract: OperationContract, matchedSource: string): SingleOperationContractResponse {
  return {
    operation: contract,
    operation_source: `operations_by_id.${contract.operation}`,
    matched_source: matchedSource,
    selection_sources: OPERATION_CONTRACTS_SELECTION_SOURCES
  };
}

function operationContractLookup(operation: string): OperationContractIndexEntry["full_contract_lookup"] {
  const args = ["contracts", "operations", "--operation", operation];
  return {
    package_helper: `getOperationContract('${operation}')`,
    cli: {
      command: commandLineForCliInterface("moryn", args),
      executable: "moryn",
      args,
      exec_file: {
        executable: "moryn",
        args
      }
    },
    mcp: {
      tool: "operation_contracts",
      arguments: { operation }
    }
  };
}

function operationContractIndexEntry(operation: OperationContract): OperationContractIndexEntry {
  return {
    operation: operation.operation,
    category: operation.category,
    summary: operation.summary,
    safe_to_run: operation.safe_to_run,
    ready_to_run: operation.execution.ready_to_run,
    next_step: operation.execution.next_step,
    mcp_tool: operation.interfaces.mcp.tool,
    cli_command: operation.interfaces.cli.command,
    required_fields: operation.required_fields,
    missing_required_fields: operation.execution.missing_required_fields,
    execution_hint: {
      guard: "execution.ready_to_run",
      ready_to_run: operation.execution.ready_to_run,
      next_step: operation.execution.next_step,
      required_fields: operation.required_fields,
      missing_required_fields: operation.execution.missing_required_fields,
      required_input_sources: {
        by_field: "execution.required_inputs_by_field.<field>",
        by_argument_path: "execution.required_inputs_by_argument_path.<argument_path>"
      }
    },
    full_contract_lookup: operationContractLookup(operation.operation)
  };
}

function operationsByMcpToolId(operations: readonly OperationContract[]): Record<string, string> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.mcp.tool, operation.operation]));
}

function operationsByCliCommandId(operations: readonly OperationContract[]): Record<string, string> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.cli.command, operation.operation]));
}

export function getOperationContractIndex(): OperationContractIndexResponse {
  const operations = OPERATION_CONTRACTS.map(operationContractIndexEntry);
  return {
    recommended_entrypoint: "agent_enter",
    index_use: "Use an operation id, MCP tool, or CLI command from this compact index to fetch one operation contract.",
    next_lookup: {
      package_helpers: {
        by_operation: "getOperationContract(operation)",
        by_mcp_tool: "getOperationContractByMcpTool(tool)",
        by_cli_command: "getOperationContractByCliCommand(command)"
      },
      cli: {
        by_operation: "moryn contracts operations --operation <operation>",
        by_mcp_tool: "moryn contracts operations --mcp-tool <tool>",
        by_cli_command: "moryn contracts operations --cli-command <command>"
      },
      mcp: {
        tool: "operation_contracts",
        by_operation_arguments: { operation: "<operation>" },
        by_mcp_tool_arguments: { mcp_tool: "<tool>" },
        by_cli_command_arguments: { cli_command: "<command>" }
      }
    },
    operations,
    operations_by_id: Object.fromEntries(operations.map((operation) => [operation.operation, operation])),
    operations_by_mcp_tool: operationsByMcpToolId(OPERATION_CONTRACTS),
    operations_by_cli_command: operationsByCliCommandId(OPERATION_CONTRACTS),
    selection_sources: {
      operation: OPERATION_CONTRACTS_SELECTION_SOURCES.operation,
      mcp_tool_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.mcp_tool_operation,
      cli_command_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_operation,
      ordered_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.ordered_operation
    }
  };
}

export function getOperationContract(operation: string): SingleOperationContractResponse | undefined {
  const contract = OPERATION_CONTRACTS_BY_ID[operation];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_id.${operation}`);
}

export function getOperationContractByMcpTool(tool: string): SingleOperationContractResponse | undefined {
  const contract = OPERATION_CONTRACTS_BY_TOOL[tool];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_mcp_tool.${tool}`);
}

export function getOperationContractByCliCommand(command: string): SingleOperationContractResponse | undefined {
  const contract = OPERATION_CONTRACTS_BY_CLI_COMMAND[command];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_cli_command.${command}`);
}

function operationsByCategory(operations: readonly OperationContract[]): Record<string, Record<string, OperationContract>> {
  const categories: Record<string, Record<string, OperationContract>> = {};
  for (const operation of operations) {
    categories[operation.category] ??= {};
    categories[operation.category][operation.operation] = operation;
  }
  return categories;
}

function operationsByMcpTool(operations: readonly OperationContract[]): Record<string, OperationContract> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.mcp.tool, operation]));
}

function operationsByCliCommand(operations: readonly OperationContract[]): Record<string, OperationContract> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.cli.command, operation]));
}

export function getOperationContracts() {
  return {
    recommended_entrypoint: "agent_enter",
    operations: OPERATION_CONTRACTS,
    operations_by_id: OPERATION_CONTRACTS_BY_ID,
    operations_by_category: operationsByCategory(OPERATION_CONTRACTS),
    operations_by_mcp_tool: operationsByMcpTool(OPERATION_CONTRACTS),
    operations_by_cli_command: operationsByCliCommand(OPERATION_CONTRACTS),
    selection_sources: OPERATION_CONTRACTS_SELECTION_SOURCES
  };
}
