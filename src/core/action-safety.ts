export interface ActionSafety {
  safe_to_auto_run: boolean;
  requires_user_confirmation: boolean;
  requires_authored_input: boolean;
  writes_local_config: boolean;
  reasons: string[];
}

export type ActionExecutionNextStep = "run" | "collect_required_fields" | "confirm_with_user" | "do_not_auto_run";

export interface ActionExecution {
  ready_to_run: boolean;
  next_step: ActionExecutionNextStep;
  missing_required_fields: string[];
  requires_user_confirmation: boolean;
  reason: string;
}

const LOCAL_CONFIG_TOOLS = new Set(["init", "project_init", "sync_init"]);

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
}): ActionExecution {
  const safety = actionSafety(input);
  if (input.required_fields.length > 0) {
    return {
      ready_to_run: false,
      next_step: "collect_required_fields",
      missing_required_fields: [...input.required_fields],
      requires_user_confirmation: safety.requires_user_confirmation,
      reason: "Action requires authored input before it can run."
    };
  }

  if (safety.requires_user_confirmation) {
    return {
      ready_to_run: false,
      next_step: "confirm_with_user",
      missing_required_fields: [],
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    };
  }

  if (!input.safe_to_run) {
    return {
      ready_to_run: false,
      next_step: "do_not_auto_run",
      missing_required_fields: [],
      requires_user_confirmation: false,
      reason: "Action is not safe to auto-run."
    };
  }

  return {
    ready_to_run: true,
    next_step: "run",
    missing_required_fields: [],
    requires_user_confirmation: false,
    reason: "Action is safe and all required fields are already filled."
  };
}
