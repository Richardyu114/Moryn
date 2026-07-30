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

function hasValidIdempotencyMetadata(value: unknown): boolean {
  const metadata = objectValue(value);
  return Boolean(
    metadata &&
      metadata.version === 1 &&
      typeof metadata.operation === "string" &&
      metadata.operation.length > 0 &&
      typeof metadata.key_digest === "string" &&
      /^[a-f0-9]{64}$/.test(metadata.key_digest) &&
      typeof metadata.request_digest === "string" &&
      /^[a-f0-9]{64}$/.test(metadata.request_digest)
  );
}

function mutationEvents(value: Record<string, unknown>): Record<string, unknown>[] {
  const events = Array.isArray(value.events) ? value.events : value.event === undefined ? [] : [value.event];
  return events
    .map(objectValue)
    .filter(
      (event): event is Record<string, unknown> =>
        event !== undefined && typeof event.event_id === "string" && typeof event.op === "string"
    );
}

function completedWithoutIdempotencyProtection(
  value: Record<string, unknown>,
  failed: boolean,
  committed: boolean
): boolean {
  if (failed || !committed) return false;
  const events = mutationEvents(value);
  if (events.length > 0) return events.some((event) => !hasValidIdempotencyMetadata(event.idempotency));
  return "idempotency_protected" in value && value.idempotency_protected !== true;
}

function inspectCommittedMutationAction(value: Record<string, unknown>) {
  const eventIds = mutationEvents(value).map((event) => event.event_id as string);
  return {
    recommended_action: "inspect_returned_committed_result_before_new_mutation",
    reason: "mutation_committed_without_idempotency_key",
    inspection_source: "returned_committed_result",
    ...(eventIds.length > 0 ? { committed_event_ids: eventIds } : {}),
    safe_to_run: true,
    retry_original_mutation: false
  } as const;
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
  const completedWithoutIdempotency = completedWithoutIdempotencyProtection(result, failed, committed);
  const action =
    nextAction(result) ?? (completedWithoutIdempotency ? inspectCommittedMutationAction(result) : undefined);
  return {
    status: failed ? "failed" : warning ? "completed_with_warnings" : "completed",
    committed,
    retryable: !completedWithoutIdempotency && (failed || (warning && retryableWarningSignal(result))),
    ...(action !== undefined ? { next_action: action } : {})
  };
}

export function failedAutomationOutcome(next_action?: unknown, error?: unknown): AutomationOutcome {
  const errorValue = objectValue(error);
  const committed = errorValue?.committed === true;
  const recoveryHint = objectValue(errorValue?.recovery_hint);
  const hasCommittedResult = recoveryHint !== undefined && "committed_result" in recoveryHint;
  const committedOutcome = hasCommittedResult ? automationOutcome(recoveryHint.committed_result) : undefined;
  const action = next_action !== undefined ? next_action : committedOutcome?.next_action;
  return {
    status: "failed",
    committed,
    retryable: committedOutcome?.retryable ?? true,
    ...(action !== undefined ? { next_action: action } : {})
  };
}
