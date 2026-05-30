export interface ActionSafety {
  safe_to_auto_run: boolean;
  requires_user_confirmation: boolean;
  requires_authored_input: boolean;
  writes_local_config: boolean;
  reasons: string[];
}

export type ActionExecutionNextStep = "run" | "collect_required_fields" | "confirm_with_user" | "do_not_auto_run";

export interface ActionRequiredInput {
  field: string;
  argument_path: string;
  argument_paths: string[];
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

export interface ActionExecution {
  ready_to_run: boolean;
  next_step: ActionExecutionNextStep;
  missing_required_fields: string[];
  required_inputs: ActionRequiredInput[];
  requires_user_confirmation: boolean;
  reason: string;
}

const LOCAL_CONFIG_TOOLS = new Set(["init", "project_init", "sync_init"]);

function argumentPaths(argumentPath: string): string[] {
  return argumentPath.split("|").map((path) => path.trim()).filter(Boolean);
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
  argument_sources?: Record<string, string>;
}): ActionExecution {
  const safety = actionSafety(input);
  const requiredInputs = input.required_fields.map((field) => {
    const metadata = input.required_fields_by_name?.[field];
    const argumentPath = metadata?.argument_path ?? field;
    return {
      field,
      argument_path: argumentPath,
      argument_paths: argumentPaths(argumentPath),
      ...(input.argument_sources?.[field] ? { argument_source: input.argument_sources[field] } : {}),
      ...(metadata && "value" in metadata ? { value: metadata.value } : {}),
      ...(metadata?.placeholder ? { placeholder: metadata.placeholder } : {}),
      ...(metadata?.alternatives ? { alternatives: metadata.alternatives } : {}),
      ...(metadata?.allowed_values ? { allowed_values: metadata.allowed_values } : {})
    };
  });
  if (input.required_fields.length > 0) {
    return {
      ready_to_run: false,
      next_step: "collect_required_fields",
      missing_required_fields: [...input.required_fields],
      required_inputs: requiredInputs,
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
      requires_user_confirmation: false,
      reason: "Action is not safe to auto-run."
    };
  }

  return {
    ready_to_run: true,
    next_step: "run",
    missing_required_fields: [],
    required_inputs: [],
    requires_user_confirmation: false,
    reason: "Action is safe and all required fields are already filled."
  };
}
