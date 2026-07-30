export type AutomationOutcomeStatus = "completed" | "completed_with_warnings" | "failed";

export interface AutomationOutcome {
  status: AutomationOutcomeStatus;
  committed: boolean;
  retryable: boolean;
  next_action?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nestedFailureSignal(value: Record<string, unknown>): boolean {
  const sync = objectValue(value.sync);
  const audit = objectValue(value.automatic_event_audit);
  return Boolean(
    value.warning ||
      (Array.isArray(value.warnings) && value.warnings.length > 0) ||
      (Array.isArray(value.failures) && value.failures.length > 0) ||
      (Array.isArray(value.deferred_work) && value.deferred_work.length > 0) ||
      value.derived_views_refreshed === false ||
      value.durability === "failed" ||
      value.durability === "best_effort" ||
      sync?.push_error ||
      objectValue(sync?.push)?.ok === false ||
      audit?.status === "failed" ||
      ["blocked", "changes_planned", "needs_attention", "needs_reconcile", "needs_review", "needs_setup"].includes(
        String(value.status)
      ) ||
      value.ready === false
  );
}

function retryableWarningSignal(value: Record<string, unknown>): boolean {
  const replayWithUnimprovableDurability =
    value.idempotent_replay === true &&
    value.durability === "best_effort" &&
    (!Array.isArray(value.warnings) ||
      value.warnings.every((warning) => objectValue(warning)?.code === "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED"));
  if (!replayWithUnimprovableDurability) return nestedFailureSignal(value);
  return nestedFailureSignal({
    ...value,
    durability: "confirmed",
    warnings: []
  });
}

function nextAction(value: Record<string, unknown>): unknown {
  if (value.next_action !== undefined) return value.next_action;
  if (value.next !== undefined) return value.next;
  const warning = objectValue(value.warning);
  if (warning?.next_action !== undefined) return warning.next_action;
  return undefined;
}

export function automationOutcome(value: unknown): AutomationOutcome {
  const result = objectValue(value);
  if (!result) return { status: "completed", committed: false, retryable: false };
  const failed = result.status === "failed" || result.ok === false;
  const warning = !failed && nestedFailureSignal(result);
  const committed = result.committed === true;
  const action = nextAction(result);
  return {
    status: failed ? "failed" : warning ? "completed_with_warnings" : "completed",
    committed,
    retryable: failed || (warning && retryableWarningSignal(result)),
    ...(action !== undefined ? { next_action: action } : {})
  };
}

export function failedAutomationOutcome(next_action?: unknown, error?: unknown): AutomationOutcome {
  const committed = objectValue(error)?.committed === true;
  return {
    status: "failed",
    committed,
    retryable: true,
    ...(next_action !== undefined ? { next_action } : {})
  };
}
