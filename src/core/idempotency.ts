import { createHash } from "node:crypto";
import type { EventIdempotency, MorynEvent } from "./types.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export class IdempotencyCollisionError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  readonly recommended_action = "retry with a new idempotency_key for the different request";
  readonly recovery_hint: {
    operation: string;
    idempotency_key_digest: string;
    expected_request_digest: string;
    received_request_digest?: string;
    retry_with: { argument: "idempotency_key"; value_placeholder: "<new unique key>" };
  };

  constructor(operation: string, expected: EventIdempotency, actual?: EventIdempotency) {
    super(`Idempotency collision: ${operation} idempotency_key was already used for a different request`);
    this.name = "IdempotencyCollisionError";
    this.recovery_hint = {
      operation,
      idempotency_key_digest: expected.key_digest,
      expected_request_digest: expected.request_digest,
      ...(actual ? { received_request_digest: actual.request_digest } : {}),
      retry_with: { argument: "idempotency_key", value_placeholder: "<new unique key>" }
    };
  }
}

export class PartialMutationCommitError extends Error {
  readonly code = "MUTATION_PARTIALLY_COMMITTED";
  readonly committed = true;
  readonly recommended_action: string;
  readonly recovery_hint: {
    operation: string;
    committed_event_ids: string[];
    retry_with:
      | { argument: "idempotency_key"; value_placeholder: "<same key>" }
      | { request: "same mutation arguments"; idempotency_key: "leave omitted" };
  };

  constructor(
    operation: string,
    committedEventIds: string[],
    cause: unknown,
    recovery: "same_key" | "same_request" = "same_key"
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Mutation partially committed: ${operation}; ${reason}`);
    this.name = "PartialMutationCommitError";
    this.recommended_action =
      recovery === "same_key"
        ? "retry the same mutation with the same idempotency_key"
        : "retry the same mutation with the same arguments and leave idempotency_key omitted";
    this.recovery_hint = {
      operation,
      committed_event_ids: committedEventIds,
      retry_with:
        recovery === "same_key"
          ? { argument: "idempotency_key", value_placeholder: "<same key>" }
          : { request: "same mutation arguments", idempotency_key: "leave omitted" }
    };
  }
}

export function validateIdempotencyKey(value: unknown, operation: string): asserts value is string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    throw new Error(
      `Invalid argument: ${operation} idempotency_key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters without control characters`
    );
  }
}

export function mutationIdempotency(
  operation: string,
  key: string | undefined,
  request: unknown
): { event_id?: string; record_id?: string; metadata?: EventIdempotency } {
  if (key === undefined) return {};
  const keyDigest = digest({ operation, key });
  return {
    event_id: `evt_idempotent_${operation.replace(/[^a-z0-9_-]/gi, "_")}_${keyDigest.slice(0, 32)}`,
    record_id: `rec_idempotent_${keyDigest.slice(0, 32)}`,
    metadata: {
      version: 1,
      operation,
      key_digest: keyDigest,
      request_digest: digest({ operation, request })
    }
  };
}

export function derivedIdempotencyKey(operation: string, request: unknown): string {
  return `${operation}:sha256:${digest({ operation, request })}`;
}

export function assertIdempotentEventMatch(actual: MorynEvent, expected: MorynEvent, operation: string): void {
  if (!expected.idempotency) return;
  const actualMetadata = actual.idempotency;
  if (
    !actualMetadata ||
    actualMetadata.operation !== expected.idempotency.operation ||
    actualMetadata.key_digest !== expected.idempotency.key_digest ||
    actualMetadata.request_digest !== expected.idempotency.request_digest
  ) {
    throw new IdempotencyCollisionError(operation, expected.idempotency, actualMetadata);
  }
}
