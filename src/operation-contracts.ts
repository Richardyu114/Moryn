import { actionSafety, type ActionSafety } from "./core/action-safety.js";
import { requiredFieldsByName, type RequiredFieldMetadata } from "./core/workflow.js";

type OperationCategory = "setup" | "core" | "sync" | "lifecycle" | "contracts" | "maintenance";

type OperationInterfaces = {
  cli: {
    command: string;
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
  argument_sources?: Record<string, string>;
  interfaces: OperationInterfaces;
  safety: ActionSafety;
};

type OperationRequiredFieldMetadata = RequiredFieldMetadata & {
  alternatives?: string[];
};

type OperationContractInput = Omit<OperationContract, "required_fields_by_name" | "safety"> & {
  required_fields_by_name?: Record<string, OperationRequiredFieldMetadata>;
};

export const OPERATION_CONTRACTS_SELECTION_SOURCES = {
  operation: "operations_by_id.<operation>",
  operation_id: "operations_by_id.<operation>.operation",
  category: "operations_by_category.<category>",
  category_operation: "operations_by_category.<category>.<operation>",
  required_field: "operations_by_id.<operation>.required_fields_by_name.<field>",
  argument_source: "operations_by_id.<operation>.argument_sources.<field>",
  cli_command: "operations_by_id.<operation>.interfaces.cli.command",
  mcp_tool: "operations_by_id.<operation>.interfaces.mcp.tool",
  ordered_operation: "operations[]"
} as const;

function userInputSources(fields: readonly string[]): Record<string, string> | undefined {
  return fields.length ? Object.fromEntries(fields.map((field) => [field, `user_input.${field}`])) : undefined;
}

function operationRequiredFieldsByName(input: OperationContractInput): Record<string, OperationRequiredFieldMetadata> {
  return {
    ...requiredFieldsByName(input.required_fields, input.interfaces.mcp.arguments),
    ...input.required_fields_by_name
  };
}

function operationContract(input: OperationContractInput): OperationContract {
  return {
    ...input,
    required_fields_by_name: operationRequiredFieldsByName(input),
    ...(input.argument_sources ? { argument_sources: input.argument_sources } : {}),
    safety: actionSafety({
      tool: input.interfaces.mcp.tool,
      safe_to_run: input.safe_to_run,
      required_fields: input.required_fields
    })
  };
}

export const OPERATION_CONTRACTS = [
  operationContract({
    operation: "agent_enter",
    category: "lifecycle",
    summary: "Recommended startup entrypoint; diagnoses setup, discovers projects, or starts a known project session.",
    safe_to_run: true,
    required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
    required_fields: [],
    interfaces: {
      cli: { command: "moryn agent enter" },
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
    interfaces: {
      cli: { command: "moryn agent guide" },
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
    interfaces: {
      cli: { command: "moryn agent doctor" },
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
    interfaces: {
      cli: { command: "moryn agent start" },
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
    interfaces: {
      cli: { command: "moryn agent status --status <status>" },
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
    interfaces: {
      cli: { command: "moryn agent finish --summary <summary>" },
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
      cli: { command: "moryn contracts selection-sources" },
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
    interfaces: {
      cli: { command: "moryn contracts operations" },
      mcp: { tool: "operation_contracts", arguments: {} }
    }
  }),
  operationContract({
    operation: "init",
    category: "setup",
    summary: "Create or update the local Moryn store configuration and directories.",
    safe_to_run: false,
    required_when: "When the store is missing and the user wants to initialize local memory.",
    required_fields: [],
    interfaces: {
      cli: { command: "moryn init" },
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
    interfaces: {
      cli: { command: "moryn project init --path <path>" },
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
    interfaces: {
      cli: { command: "moryn project list" },
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
    interfaces: {
      cli: { command: "moryn boot" },
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
    interfaces: {
      cli: { command: "moryn recall" },
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
    required_fields_by_name: {
      text_or_content: {
        name: "text_or_content",
        argument_path: "text|content",
        placeholder: "<text_or_content>",
        alternatives: ["text", "content"]
      }
    },
    interfaces: {
      cli: { command: "moryn write --kind <kind> --type <type> --scope <scope> --text <text>" },
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
    interfaces: {
      cli: { command: "moryn revise <record_id> --set <path=value>" },
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
    interfaces: {
      cli: { command: "moryn promote <record_id> --state <state>" },
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
    interfaces: {
      cli: { command: "moryn archive <record_id>" },
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
    interfaces: {
      cli: { command: "moryn quarantine <record_id>" },
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
    interfaces: {
      cli: { command: "moryn link <record_id> <linked_record_id> --type <type>" },
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
    interfaces: {
      cli: { command: "moryn list-recent" },
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
    interfaces: {
      cli: { command: "moryn refresh" },
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
    interfaces: {
      cli: { command: "moryn sync init <remote>" },
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
    interfaces: {
      cli: { command: "moryn sync --status" },
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
    interfaces: {
      cli: { command: "moryn sync --pull" },
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
    interfaces: {
      cli: { command: "moryn sync --push" },
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
    interfaces: {
      cli: { command: "moryn rebuild" },
      mcp: { tool: "rebuild", arguments: {} }
    }
  })
] as const satisfies readonly OperationContract[];

function operationsById(operations: readonly OperationContract[]): Record<string, OperationContract> {
  return Object.fromEntries(operations.map((operation) => [operation.operation, operation]));
}

function operationsByCategory(operations: readonly OperationContract[]): Record<string, Record<string, OperationContract>> {
  const categories: Record<string, Record<string, OperationContract>> = {};
  for (const operation of operations) {
    categories[operation.category] ??= {};
    categories[operation.category][operation.operation] = operation;
  }
  return categories;
}

export function getOperationContracts() {
  return {
    recommended_entrypoint: "agent_enter",
    operations: OPERATION_CONTRACTS,
    operations_by_id: operationsById(OPERATION_CONTRACTS),
    operations_by_category: operationsByCategory(OPERATION_CONTRACTS),
    selection_sources: OPERATION_CONTRACTS_SELECTION_SOURCES
  };
}
