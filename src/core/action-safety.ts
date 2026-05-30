export interface ActionSafety {
  safe_to_auto_run: boolean;
  requires_user_confirmation: boolean;
  requires_authored_input: boolean;
  writes_local_config: boolean;
  reasons: string[];
}

export type ActionExecutionNextStep = "run" | "collect_required_fields" | "confirm_with_user" | "do_not_auto_run";

export interface ActionMcpTarget {
  argument: string;
  path?: string;
  type?: string;
  required?: boolean;
  preferred: boolean;
}

export interface ActionRequiredInput {
  field: string;
  argument_path: string;
  argument_paths: string[];
  mcp_targets?: ActionMcpTarget[];
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
  mcp?: {
    argument: string;
    path?: string;
  };
};

export interface ActionExecution {
  ready_to_run: boolean;
  next_step: ActionExecutionNextStep;
  missing_required_fields: string[];
  required_inputs: ActionRequiredInput[];
  required_inputs_by_field: Record<string, ActionRequiredInput>;
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
}): ActionExecution {
  const safety = actionSafety(input);
  const requiredInputs = input.required_fields.map((field) => {
    const metadata = input.required_fields_by_name?.[field];
    const argumentPath = metadata?.argument_path ?? field;
    const splitArgumentPaths = argumentPaths(argumentPath);
    const targets = mcpTargets(splitArgumentPaths, input.arguments_by_name);
    return {
      field,
      argument_path: argumentPath,
      argument_paths: splitArgumentPaths,
      ...(targets ? { mcp_targets: targets } : {}),
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
  if (input.required_fields.length > 0) {
    return {
      ready_to_run: false,
      next_step: "collect_required_fields",
      missing_required_fields: [...input.required_fields],
      required_inputs: requiredInputs,
      required_inputs_by_field: requiredInputsByField,
      requires_user_confirmation: safety.requires_user_confirmation,
      reason: "Action requires authored input before it can run."
    };
  }

  if (safety.requires_user_confirmation) {
    return {
      ready_to_run: false,
      next_step: "confirm_with_user",
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    };
  }

  if (!input.safe_to_run) {
    return {
      ready_to_run: false,
      next_step: "do_not_auto_run",
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      requires_user_confirmation: false,
      reason: "Action is not safe to auto-run."
    };
  }

  return {
    ready_to_run: true,
    next_step: "run",
    missing_required_fields: [],
    required_inputs: [],
    required_inputs_by_field: {},
    requires_user_confirmation: false,
    reason: "Action is safe and all required fields are already filled."
  };
}
