export interface ActionSafety {
  safe_to_auto_run: boolean;
  requires_user_confirmation: boolean;
  requires_authored_input: boolean;
  writes_local_config: boolean;
  reasons: string[];
}

export type ActionExecutionNextStep = "run" | "collect_required_fields" | "confirm_with_user" | "do_not_auto_run";
export type ActionExecutionBlocker = "required_fields" | "user_confirmation" | "unsafe_action";
export type ActionRunbookStepName = "collect_required_inputs" | "ask_user_confirmation" | "call_mcp" | "do_not_run";

export interface ActionRunbookCollectRequiredInputsStep {
  step: "collect_required_inputs";
  reason: "required_fields";
  missing_required_fields: "execution.missing_required_fields";
  required_inputs: "execution.required_inputs";
  required_inputs_by_field: "execution.required_inputs_by_field";
  required_inputs_by_argument_path: "execution.required_inputs_by_argument_path";
}

export interface ActionRunbookAskUserConfirmationStep {
  step: "ask_user_confirmation";
  reason: "user_confirmation";
  confirmation_required: "execution.requires_user_confirmation";
}

export interface ActionRunbookCallMcpStep {
  step: "call_mcp";
  transport: "mcp";
  guard: "execution.ready_to_run";
  mcp: "interfaces.mcp";
  mcp_tool: "interfaces.mcp.tool";
  mcp_arguments: "interfaces.mcp.arguments";
  cli_exec_file: "interfaces.cli.exec_file";
  cli_command_line: "interfaces.cli.command_line";
  cli_placeholders: "interfaces.cli.placeholders";
}

export interface ActionRunbookDoNotRunStep {
  step: "do_not_run";
  reason: "unsafe_action";
  blocked_by: "execution.blocked_by";
}

export type ActionRunbookStep =
  | ActionRunbookCollectRequiredInputsStep
  | ActionRunbookAskUserConfirmationStep
  | ActionRunbookCallMcpStep
  | ActionRunbookDoNotRunStep;

export interface ActionRunbook {
  next: ActionRunbookStepName;
  steps: ActionRunbookStep[];
}

export interface ActionMcpTarget {
  argument: string;
  path?: string;
  type?: string;
  required?: boolean;
  preferred: boolean;
}

export interface ActionCliTarget {
  flag?: string;
  flags?: readonly string[];
  positional?: string;
  type?: string;
  required?: boolean;
  repeatable?: boolean;
  default?: unknown;
  preferred: boolean;
}

export interface ActionRequiredInput {
  field: string;
  argument_path: string;
  argument_paths: string[];
  selection_sources?: Record<string, string>;
  mcp_targets?: ActionMcpTarget[];
  cli_targets?: ActionCliTarget[];
  argument_source?: string;
  value?: unknown;
  placeholder?: string;
  alternatives?: readonly string[];
  allowed_values?: readonly string[];
}

type RequiredFieldInputMetadata = {
  argument_path?: string;
  value?: unknown;
  placeholder?: string;
  alternatives?: readonly string[];
  allowed_values?: readonly string[];
};

type ArgumentInputMetadata = {
  type?: string;
  required?: boolean;
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
};

export interface ActionExecution {
  ready_to_run: boolean;
  next_step: ActionExecutionNextStep;
  blocked_by: ActionExecutionBlocker[];
  missing_required_fields: string[];
  required_inputs: ActionRequiredInput[];
  required_inputs_by_field: Record<string, ActionRequiredInput>;
  required_inputs_by_argument_path: Record<string, ActionRequiredInput>;
  runbook: ActionRunbook;
  requires_user_confirmation: boolean;
  reason: string;
}

const LOCAL_CONFIG_TOOLS = new Set(["init", "project_init", "sync_init"]);

function argumentPaths(argumentPath: string): string[] {
  return argumentPath.split("|").map((path) => path.trim()).filter(Boolean);
}

function mcpTargets(
  paths: string[],
  argumentsByName?: Record<string, ArgumentInputMetadata>
): ActionMcpTarget[] | undefined {
  if (!argumentsByName) return undefined;

  const targets = paths.flatMap((argumentPath, index) => {
    const directMetadata = argumentsByName[argumentPath];
    const nestedMetadata = Object.values(argumentsByName).find((metadata) => metadata.mcp?.path === argumentPath);
    const metadata = directMetadata ?? nestedMetadata;
    if (!metadata?.mcp) return [];
    return [{
      argument: metadata.mcp.argument,
      ...(metadata.mcp.path ? { path: metadata.mcp.path } : {}),
      ...(metadata.type ? { type: metadata.type } : {}),
      ...(typeof metadata.required === "boolean" ? { required: metadata.required } : {}),
      preferred: index === 0
    }];
  });

  return targets.length > 0 ? targets : undefined;
}

function cliTargets(
  paths: string[],
  argumentsByName?: Record<string, ArgumentInputMetadata>,
  field?: string
): ActionCliTarget[] | undefined {
  if (!argumentsByName) return undefined;

  const targets = paths.flatMap((argumentPath, index) => {
    const directMetadata = argumentsByName[argumentPath];
    const fieldMetadata = field ? argumentsByName[field] : undefined;
    const metadata = directMetadata ?? fieldMetadata;
    if (!metadata?.cli) return [];
    return [{
      ...(metadata.cli.flag ? { flag: metadata.cli.flag } : {}),
      ...(metadata.cli.flags ? { flags: metadata.cli.flags } : {}),
      ...(metadata.cli.positional ? { positional: metadata.cli.positional } : {}),
      ...(metadata.type ? { type: metadata.type } : {}),
      ...(typeof metadata.required === "boolean" ? { required: metadata.required } : {}),
      ...(typeof metadata.cli.repeatable === "boolean" ? { repeatable: metadata.cli.repeatable } : {}),
      ...("default" in metadata.cli ? { default: metadata.cli.default } : {}),
      preferred: index === 0
    }];
  });

  return targets.length > 0 ? targets : undefined;
}

const COLLECT_REQUIRED_INPUTS_STEP: ActionRunbookCollectRequiredInputsStep = {
  step: "collect_required_inputs",
  reason: "required_fields",
  missing_required_fields: "execution.missing_required_fields",
  required_inputs: "execution.required_inputs",
  required_inputs_by_field: "execution.required_inputs_by_field",
  required_inputs_by_argument_path: "execution.required_inputs_by_argument_path"
};

const ASK_USER_CONFIRMATION_STEP: ActionRunbookAskUserConfirmationStep = {
  step: "ask_user_confirmation",
  reason: "user_confirmation",
  confirmation_required: "execution.requires_user_confirmation"
};

const CALL_MCP_STEP: ActionRunbookCallMcpStep = {
  step: "call_mcp",
  transport: "mcp",
  guard: "execution.ready_to_run",
  mcp: "interfaces.mcp",
  mcp_tool: "interfaces.mcp.tool",
  mcp_arguments: "interfaces.mcp.arguments",
  cli_exec_file: "interfaces.cli.exec_file",
  cli_command_line: "interfaces.cli.command_line",
  cli_placeholders: "interfaces.cli.placeholders"
};

const DO_NOT_RUN_STEP: ActionRunbookDoNotRunStep = {
  step: "do_not_run",
  reason: "unsafe_action",
  blocked_by: "execution.blocked_by"
};

function actionRunbook(blockedBy: ActionExecutionBlocker[]): ActionRunbook {
  const steps: ActionRunbookStep[] = [];
  if (blockedBy.includes("required_fields")) steps.push({ ...COLLECT_REQUIRED_INPUTS_STEP });
  if (blockedBy.includes("user_confirmation")) steps.push({ ...ASK_USER_CONFIRMATION_STEP });
  if (blockedBy.includes("unsafe_action")) steps.push({ ...DO_NOT_RUN_STEP });
  if (!blockedBy.includes("unsafe_action")) steps.push({ ...CALL_MCP_STEP });

  return {
    next: steps[0]?.step ?? "call_mcp",
    steps
  };
}

export function actionSafety(input: {
  tool: string;
  safe_to_run: boolean;
  required_fields: string[];
}): ActionSafety {
  const requiresAuthoredInput = input.required_fields.length > 0;
  const writesLocalConfig = LOCAL_CONFIG_TOOLS.has(input.tool);
  const requiresUserConfirmation = writesLocalConfig || (!input.safe_to_run && !requiresAuthoredInput);
  const reasons: string[] = [];

  if (requiresAuthoredInput) reasons.push("required_fields");
  if (writesLocalConfig) reasons.push("writes_local_config");
  if (requiresUserConfirmation) reasons.push("requires_user_confirmation");
  if (reasons.length === 0) reasons.push("safe_read_or_status_check");

  return {
    safe_to_auto_run: input.safe_to_run,
    requires_user_confirmation: requiresUserConfirmation,
    requires_authored_input: requiresAuthoredInput,
    writes_local_config: writesLocalConfig,
    reasons
  };
}

export function actionExecution(input: {
  tool: string;
  safe_to_run: boolean;
  required_fields: string[];
  required_fields_by_name?: Record<string, RequiredFieldInputMetadata>;
  arguments_by_name?: Record<string, ArgumentInputMetadata>;
  argument_sources?: Record<string, string>;
  required_input_selection_sources?: Record<string, string>;
}): ActionExecution {
  const safety = actionSafety(input);
  const requiredInputs = input.required_fields.map((field) => {
    const metadata = input.required_fields_by_name?.[field];
    const argumentPath = metadata?.argument_path ?? field;
    const splitArgumentPaths = argumentPaths(argumentPath);
    const mcpTargetList = mcpTargets(splitArgumentPaths, input.arguments_by_name);
    const cliTargetList = cliTargets(splitArgumentPaths, input.arguments_by_name, field);
    return {
      field,
      argument_path: argumentPath,
      argument_paths: splitArgumentPaths,
      ...(input.required_input_selection_sources && Object.keys(input.required_input_selection_sources).length > 0
        ? { selection_sources: input.required_input_selection_sources }
        : {}),
      ...(mcpTargetList ? { mcp_targets: mcpTargetList } : {}),
      ...(cliTargetList ? { cli_targets: cliTargetList } : {}),
      ...(input.argument_sources?.[field] ? { argument_source: input.argument_sources[field] } : {}),
      ...(metadata && "value" in metadata ? { value: metadata.value } : {}),
      ...(metadata?.placeholder ? { placeholder: metadata.placeholder } : {}),
      ...(metadata?.alternatives ? { alternatives: metadata.alternatives } : {}),
      ...(metadata?.allowed_values ? { allowed_values: metadata.allowed_values } : {})
    };
  });
  const requiredInputsByField = Object.fromEntries(
    requiredInputs.map((requiredInput) => [requiredInput.field, requiredInput])
  );
  const requiredInputsByArgumentPath = Object.fromEntries(
    requiredInputs.flatMap((requiredInput) =>
      requiredInput.argument_paths.map((argumentPath) => [argumentPath, requiredInput])
    )
  );
  if (input.required_fields.length > 0) {
    const blocked_by: ActionExecutionBlocker[] = [
      "required_fields",
      ...(safety.requires_user_confirmation ? ["user_confirmation" as const] : [])
    ];
    return {
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by,
      missing_required_fields: [...input.required_fields],
      required_inputs: requiredInputs,
      required_inputs_by_field: requiredInputsByField,
      required_inputs_by_argument_path: requiredInputsByArgumentPath,
      runbook: actionRunbook(blocked_by),
      requires_user_confirmation: safety.requires_user_confirmation,
      reason: "Action requires authored input before it can run."
    };
  }

  if (safety.requires_user_confirmation) {
    const blocked_by: ActionExecutionBlocker[] = ["user_confirmation"];
    return {
      ready_to_run: false,
      next_step: "confirm_with_user",
      blocked_by,
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: actionRunbook(blocked_by),
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    };
  }

  if (!input.safe_to_run) {
    const blocked_by: ActionExecutionBlocker[] = ["unsafe_action"];
    return {
      ready_to_run: false,
      next_step: "do_not_auto_run",
      blocked_by,
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: actionRunbook(blocked_by),
      requires_user_confirmation: false,
      reason: "Action is not safe to auto-run."
    };
  }

  return {
    ready_to_run: true,
    next_step: "run",
    blocked_by: [],
    missing_required_fields: [],
    required_inputs: [],
    required_inputs_by_field: {},
    required_inputs_by_argument_path: {},
    runbook: actionRunbook([]),
    requires_user_confirmation: false,
    reason: "Action is safe and all required fields are already filled."
  };
}
