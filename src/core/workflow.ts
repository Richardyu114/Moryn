export function phasesByName<TPhase extends { phase: string }>(phases: TPhase[]): Record<string, TPhase> {
  return Object.fromEntries(phases.map((phase) => [phase.phase, phase]));
}

export function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(
  workflow: TWorkflow
): TWorkflow & { phases_by_name: Record<string, TWorkflow["phases"][number]> } {
  return {
    ...workflow,
    phases_by_name: phasesByName(workflow.phases)
  };
}

export interface RequiredFieldMetadata {
  name: string;
  argument_path: string;
  value?: unknown;
  placeholder?: string;
}

export function requiredFieldsByName(
  requiredFields: string[],
  args: Record<string, unknown>
): Record<string, RequiredFieldMetadata> {
  return Object.fromEntries(requiredFields.map((field) => {
    const value = args[field];
    const placeholder = typeof value === "string" && /^<[^<>]+>$/.test(value) ? value : undefined;
    return [field, {
      name: field,
      argument_path: field,
      ...(value !== undefined ? { value } : {}),
      ...(placeholder ? { placeholder } : {})
    }];
  }));
}

export function withRequiredFieldsByName<TAction extends {
  required_fields: string[];
  arguments: Record<string, unknown>;
}>(
  action: TAction
): TAction & { required_fields_by_name: Record<string, RequiredFieldMetadata> } {
  return {
    ...action,
    required_fields_by_name: requiredFieldsByName(action.required_fields, action.arguments)
  };
}
