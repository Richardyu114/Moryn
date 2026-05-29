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
