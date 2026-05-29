export interface ActionSafety {
  safe_to_auto_run: boolean;
  requires_user_confirmation: boolean;
  requires_authored_input: boolean;
  writes_local_config: boolean;
  reasons: string[];
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
