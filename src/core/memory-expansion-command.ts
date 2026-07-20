export interface MemoryExpansionCommandInput {
  record_id: string;
  max_depth?: number;
  max_records?: number;
  include_private?: boolean;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid argument: memory expansion input must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < minimum || (normalized as number) > maximum) {
    throw new Error(`Invalid argument: memory expansion ${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized as number;
}

export function normalizeMemoryExpansionCommand(value: unknown): MemoryExpansionCommandInput {
  const object = plainObject(value);
  const allowed = ["record_id", "max_depth", "max_records", "include_private"];
  const unknown = Object.keys(object).find((field) => !allowed.includes(field));
  if (unknown) throw new Error(`Invalid argument: Unknown memory expansion input.${unknown}`);
  if (typeof object.record_id !== "string" || !object.record_id.trim()) {
    throw new Error("Invalid argument: memory expansion record_id must be a non-empty string");
  }
  if (object.include_private !== undefined && typeof object.include_private !== "boolean") {
    throw new Error("Invalid argument: memory expansion include_private must be a boolean");
  }
  return {
    record_id: object.record_id.trim(),
    max_depth: boundedInteger(object.max_depth, 2, 0, 16, "max_depth"),
    max_records: boundedInteger(object.max_records, 100, 1, 10_000, "max_records"),
    include_private: object.include_private === true
  };
}
