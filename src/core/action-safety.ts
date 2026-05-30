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
  required_input_collect: "execution.required_inputs[].collect";
  required_input_apply_to: "execution.required_inputs[].collect.apply_to";
  required_input_assignment_mode: "execution.required_inputs[].collect.apply_to.assignment_mode";
  required_input_expected_value: "execution.required_inputs[].collect.expected_value";
  required_input_choices: "execution.required_inputs[].collect.choices[]";
  required_input_choice_apply_to: "execution.required_inputs[].collect.choices[].apply_to";
  required_input_choice_expected_value: "execution.required_inputs[].collect.choices[].expected_value";
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

export interface ActionMcpAssignment {
  argument: string;
  path?: string;
  value_path: string;
  preferred: boolean;
}

export type ActionCliValueEncoding = "string" | "json" | "repeat_values" | "path_value_entries" | "object_fields";

export interface ActionCliFlagValuePath {
  flag: string;
  value_path: string;
}

export interface ActionCliAssignment {
  flag?: string;
  flags?: readonly string[];
  positional?: string;
  value_path: string;
  argv_template: string[];
  value_encoding: ActionCliValueEncoding;
  flag_value_paths?: ActionCliFlagValuePath[];
  type?: string;
  required?: boolean;
  repeatable?: boolean;
  default?: unknown;
  preferred: boolean;
}

export type ActionRequiredInputValueKind =
  | "string"
  | "number"
  | "boolean"
  | "string_list"
  | "json_object"
  | "path_value_entries"
  | "object_fields"
  | "enum";

export interface ActionRequiredInputExpectedValue {
  value_path: string;
  kind: ActionRequiredInputValueKind;
  value_encoding?: ActionCliValueEncoding;
  type?: string;
  repeatable?: boolean;
  allowed_values?: readonly string[];
  flag_value_paths?: ActionCliFlagValuePath[];
}

export interface ActionRequiredInputApplyTo {
  assignment_mode?: ActionRequiredInputMode;
  mcp_argument_paths: string[];
  mcp_assignments?: ActionMcpAssignment[];
  cli_assignments?: ActionCliAssignment[];
  mcp_targets?: ActionMcpTarget[];
  cli_targets?: ActionCliTarget[];
}

export type ActionRequiredInputMode = "choose_one";

export interface ActionRequiredInputChoice {
  option: string;
  argument_path: string;
  value_path: string;
  preferred: boolean;
  type?: string;
  expected_value?: ActionRequiredInputExpectedValue;
  apply_to: ActionRequiredInputApplyTo;
}

export interface ActionRequiredInputCollect {
  source: "user";
  input_key: string;
  prompt: string;
  apply_to: ActionRequiredInputApplyTo;
  value_path?: string;
  expected_value?: ActionRequiredInputExpectedValue;
  input_mode?: ActionRequiredInputMode;
  choices?: ActionRequiredInputChoice[];
  placeholder?: string;
  alternatives?: readonly string[];
  allowed_values?: readonly string[];
}

export interface ActionRequiredInput {
  field: string;
  argument_path: string;
  argument_paths: string[];
  collect: ActionRequiredInputCollect;
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
  allowed_values?: readonly string[];
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

function mcpAssignments(targets: ActionMcpTarget[] | undefined, valuePath: string): ActionMcpAssignment[] | undefined {
  if (!targets?.length) return undefined;
  return targets.map((target) => ({
    argument: target.argument,
    ...(target.path ? { path: target.path } : {}),
    value_path: valuePath,
    preferred: target.preferred
  }));
}

const CLI_FLAG_OBJECT_KEYS: Record<string, string[]> = {
  agent: ["client", "session_id", "model", "device_id"]
};

function valuePlaceholder(valuePath: string, encoding: ActionCliValueEncoding): string {
  if (encoding === "json") return `<json:${valuePath}>`;
  if (encoding === "repeat_values") return `<${valuePath}[]>`;
  if (encoding === "path_value_entries") return `<${valuePath}{path=value}[]>`;
  return `<${valuePath}>`;
}

function cliValueEncoding(target: ActionCliTarget): ActionCliValueEncoding {
  if (target.flags?.length) return "object_fields";
  if (target.type === "object" && target.repeatable) return "path_value_entries";
  if (target.type === "object") return "json";
  if (target.repeatable) return "repeat_values";
  return "string";
}

function cliFlagValuePaths(flags: readonly string[], valuePath: string): ActionCliFlagValuePath[] {
  const objectPath = valuePath.replace(/^user_input\./, "");
  const keys = CLI_FLAG_OBJECT_KEYS[objectPath] ?? flags.map((flag) => flag.replace(/^--/, "").replace(/-/g, "_"));
  return flags.map((flag, index) => ({
    flag,
    value_path: `${valuePath}.${keys[index] ?? flag.replace(/^--/, "").replace(/-/g, "_")}`
  }));
}

function cliArgvTemplate(target: ActionCliTarget, valuePath: string, encoding: ActionCliValueEncoding): string[] {
  if (target.flags?.length) {
    return cliFlagValuePaths(target.flags, valuePath).flatMap((entry) => [entry.flag, `<${entry.value_path}>`]);
  }
  const placeholder = valuePlaceholder(valuePath, encoding);
  if (target.positional) return [placeholder];
  if (target.flag) return [target.flag, placeholder];
  return [placeholder];
}

function cliAssignments(targets: ActionCliTarget[] | undefined, valuePath: string): ActionCliAssignment[] | undefined {
  if (!targets?.length) return undefined;
  return targets.map((target) => {
    const value_encoding = cliValueEncoding(target);
    const flag_value_paths = target.flags?.length ? cliFlagValuePaths(target.flags, valuePath) : undefined;
    return {
      ...(target.flag ? { flag: target.flag } : {}),
      ...(target.flags ? { flags: target.flags } : {}),
      ...(target.positional ? { positional: target.positional } : {}),
      value_path: valuePath,
      argv_template: cliArgvTemplate(target, valuePath, value_encoding),
      value_encoding,
      ...(flag_value_paths ? { flag_value_paths } : {}),
      ...(target.type ? { type: target.type } : {}),
      ...(typeof target.required === "boolean" ? { required: target.required } : {}),
      ...(typeof target.repeatable === "boolean" ? { repeatable: target.repeatable } : {}),
      ...("default" in target ? { default: target.default } : {}),
      preferred: target.preferred
    };
  });
}

function valueKind(input: {
  type?: string;
  value_encoding?: ActionCliValueEncoding;
  allowed_values?: readonly string[];
}): ActionRequiredInputValueKind {
  if (input.allowed_values?.length) return "enum";
  if (input.value_encoding === "json") return "json_object";
  if (input.value_encoding === "repeat_values") return "string_list";
  if (input.value_encoding === "path_value_entries") return "path_value_entries";
  if (input.value_encoding === "object_fields") return "object_fields";
  if (input.type === "object") return "json_object";
  if (input.type === "string[]") return "string_list";
  if (input.type === "number") return "number";
  if (input.type === "boolean") return "boolean";
  return "string";
}

function expectedValue(input: {
  value_path: string;
  mcp_targets?: ActionMcpTarget[];
  cli_assignments?: ActionCliAssignment[];
  cli_targets?: ActionCliTarget[];
  allowed_values?: readonly string[];
}): ActionRequiredInputExpectedValue {
  const cliAssignment = input.cli_assignments?.[0];
  const cliTarget = input.cli_targets?.[0];
  const mcpTarget = input.mcp_targets?.[0];
  const type = cliAssignment?.type ?? cliTarget?.type ?? mcpTarget?.type;
  const repeatable = cliAssignment?.repeatable ?? cliTarget?.repeatable;
  const value_encoding = cliAssignment?.value_encoding;
  const flag_value_paths = cliAssignment?.flag_value_paths;

  return {
    value_path: input.value_path,
    kind: valueKind({ type, value_encoding, allowed_values: input.allowed_values }),
    ...(value_encoding ? { value_encoding } : {}),
    ...(type ? { type } : {}),
    ...(typeof repeatable === "boolean" ? { repeatable } : {}),
    ...(input.allowed_values ? { allowed_values: input.allowed_values } : {}),
    ...(flag_value_paths ? { flag_value_paths } : {})
  };
}

function collectApplyTo(input: {
  paths: string[];
  mcp_targets?: ActionMcpTarget[];
  mcp_assignments?: ActionMcpAssignment[];
  cli_assignments?: ActionCliAssignment[];
  cli_targets?: ActionCliTarget[];
  assignment_mode?: ActionRequiredInputMode;
}): ActionRequiredInputApplyTo {
  return {
    ...(input.assignment_mode ? { assignment_mode: input.assignment_mode } : {}),
    mcp_argument_paths: input.paths,
    ...(input.mcp_assignments ? { mcp_assignments: input.mcp_assignments } : {}),
    ...(input.cli_assignments ? { cli_assignments: input.cli_assignments } : {}),
    ...(input.mcp_targets ? { mcp_targets: input.mcp_targets } : {}),
    ...(input.cli_targets ? { cli_targets: input.cli_targets } : {})
  };
}

function markMcpPreferred(targets: ActionMcpTarget[] | undefined, preferred: boolean): ActionMcpTarget[] | undefined {
  return targets?.map((target) => ({ ...target, preferred }));
}

function markCliPreferred(targets: ActionCliTarget[] | undefined, preferred: boolean): ActionCliTarget[] | undefined {
  return targets?.map((target) => ({ ...target, preferred }));
}

function targetType(
  mcp_targets: ActionMcpTarget[] | undefined,
  cli_targets: ActionCliTarget[] | undefined
): string | undefined {
  return cli_targets?.[0]?.type ?? mcp_targets?.[0]?.type;
}

function requiredInputChoices(input: {
  field: string;
  paths: string[];
  arguments_by_name?: Record<string, ArgumentInputMetadata>;
  value_path: string;
}): ActionRequiredInputChoice[] | undefined {
  if (input.paths.length < 2) return undefined;

  return input.paths.map((argumentPath, index) => {
    const preferred = index === 0;
    const choiceMcpTargets = markMcpPreferred(mcpTargets([argumentPath], input.arguments_by_name), preferred);
    const choiceCliTargets = markCliPreferred(cliTargets([argumentPath], input.arguments_by_name, input.field), preferred);
    const choiceMcpAssignments = mcpAssignments(choiceMcpTargets, input.value_path);
    const choiceCliAssignments = cliAssignments(choiceCliTargets, input.value_path);
    const type = targetType(choiceMcpTargets, choiceCliTargets);
    const metadata = input.arguments_by_name?.[argumentPath];

    return {
      option: argumentPath,
      argument_path: argumentPath,
      value_path: input.value_path,
      preferred,
      ...(type ? { type } : {}),
      expected_value: expectedValue({
        value_path: input.value_path,
        ...(choiceMcpTargets ? { mcp_targets: choiceMcpTargets } : {}),
        ...(choiceCliAssignments ? { cli_assignments: choiceCliAssignments } : {}),
        ...(choiceCliTargets ? { cli_targets: choiceCliTargets } : {}),
        ...(metadata?.allowed_values ? { allowed_values: metadata.allowed_values } : {})
      }),
      apply_to: collectApplyTo({
        paths: [argumentPath],
        ...(choiceMcpTargets ? { mcp_targets: choiceMcpTargets } : {}),
        ...(choiceMcpAssignments ? { mcp_assignments: choiceMcpAssignments } : {}),
        ...(choiceCliAssignments ? { cli_assignments: choiceCliAssignments } : {}),
        ...(choiceCliTargets ? { cli_targets: choiceCliTargets } : {})
      })
    };
  });
}

function promptForRequiredInput(field: string): string {
  return `Provide ${field.replace(/_/g, " ")}.`;
}

function collectRequiredInput(input: {
  field: string;
  paths: string[];
  mcp_targets?: ActionMcpTarget[];
  mcp_assignments?: ActionMcpAssignment[];
  cli_assignments?: ActionCliAssignment[];
  cli_targets?: ActionCliTarget[];
  argument_source?: string;
  expected_value?: ActionRequiredInputExpectedValue;
  choices?: ActionRequiredInputChoice[];
  placeholder?: string;
  alternatives?: readonly string[];
  allowed_values?: readonly string[];
}): ActionRequiredInputCollect {
  return {
    source: "user",
    input_key: input.field,
    prompt: promptForRequiredInput(input.field),
    apply_to: collectApplyTo({
      ...input,
      ...(input.choices ? { assignment_mode: "choose_one" as const } : {})
    }),
    ...(input.argument_source ? { value_path: input.argument_source } : {}),
    ...(input.expected_value ? { expected_value: input.expected_value } : {}),
    ...(input.choices ? { input_mode: "choose_one" as const, choices: input.choices } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    ...(input.alternatives ? { alternatives: input.alternatives } : {}),
    ...(input.allowed_values ? { allowed_values: input.allowed_values } : {})
  };
}

const COLLECT_REQUIRED_INPUTS_STEP: ActionRunbookCollectRequiredInputsStep = {
  step: "collect_required_inputs",
  reason: "required_fields",
  missing_required_fields: "execution.missing_required_fields",
  required_inputs: "execution.required_inputs",
  required_input_collect: "execution.required_inputs[].collect",
  required_input_apply_to: "execution.required_inputs[].collect.apply_to",
  required_input_assignment_mode: "execution.required_inputs[].collect.apply_to.assignment_mode",
  required_input_expected_value: "execution.required_inputs[].collect.expected_value",
  required_input_choices: "execution.required_inputs[].collect.choices[]",
  required_input_choice_apply_to: "execution.required_inputs[].collect.choices[].apply_to",
  required_input_choice_expected_value: "execution.required_inputs[].collect.choices[].expected_value",
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
    const argumentSource = input.argument_sources?.[field] ?? `user_input.${field}`;
    const placeholder = metadata?.placeholder;
    const mcpAssignmentList = mcpAssignments(mcpTargetList, argumentSource);
    const cliAssignmentList = cliAssignments(cliTargetList, argumentSource);
    const choices = requiredInputChoices({
      field,
      paths: splitArgumentPaths,
      arguments_by_name: input.arguments_by_name,
      value_path: argumentSource
    });
    const collectExpectedValue = choices
      ? undefined
      : expectedValue({
        value_path: argumentSource,
        ...(mcpTargetList ? { mcp_targets: mcpTargetList } : {}),
        ...(cliAssignmentList ? { cli_assignments: cliAssignmentList } : {}),
        ...(cliTargetList ? { cli_targets: cliTargetList } : {}),
        ...(metadata?.allowed_values ? { allowed_values: metadata.allowed_values } : {})
      });
    return {
      field,
      argument_path: argumentPath,
      argument_paths: splitArgumentPaths,
      collect: collectRequiredInput({
        field,
        paths: splitArgumentPaths,
        ...(mcpTargetList ? { mcp_targets: mcpTargetList } : {}),
        ...(mcpAssignmentList ? { mcp_assignments: mcpAssignmentList } : {}),
        ...(cliAssignmentList ? { cli_assignments: cliAssignmentList } : {}),
        ...(cliTargetList ? { cli_targets: cliTargetList } : {}),
        ...(argumentSource ? { argument_source: argumentSource } : {}),
        ...(collectExpectedValue ? { expected_value: collectExpectedValue } : {}),
        ...(choices ? { choices } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(metadata?.alternatives ? { alternatives: metadata.alternatives } : {}),
        ...(metadata?.allowed_values ? { allowed_values: metadata.allowed_values } : {})
      }),
      ...(input.required_input_selection_sources && Object.keys(input.required_input_selection_sources).length > 0
        ? { selection_sources: input.required_input_selection_sources }
        : {}),
      ...(mcpTargetList ? { mcp_targets: mcpTargetList } : {}),
      ...(cliTargetList ? { cli_targets: cliTargetList } : {}),
      ...(input.argument_sources?.[field] ? { argument_source: input.argument_sources[field] } : {}),
      ...(metadata && "value" in metadata ? { value: metadata.value } : {}),
      ...(placeholder ? { placeholder } : {}),
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
