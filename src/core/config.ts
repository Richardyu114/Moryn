import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createId } from "./id.js";

const storeConfigSchema = z.object({
  store_version: z.literal(1),
  device_id: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type StoreConfig = z.infer<typeof storeConfigSchema>;

export const STORE_INIT_SELECTION_SOURCES = {
  store: "store",
  config: "config",
  config_file: "artifacts.config",
  store_version: "config.store_version",
  device_id: "config.device_id"
} as const;

export interface InitializeStoreResult {
  config: StoreConfig;
  store: string;
  artifacts: {
    config: string;
  };
  selection_sources: typeof STORE_INIT_SELECTION_SOURCES;
}

export interface InitializeStoreOptions {
  now?: () => string;
  id?: () => string;
  repair?: boolean;
}

const INIT_OPERATION_CONTRACT_SOURCE = "operations_by_id.init";
const INIT_REPAIR_ARGUMENT_SOURCE = "operations_by_id.init.arguments_by_name.repair";

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

class StorePathArgumentError extends Error {
  readonly recommended_action = "retry store operation with a non-empty storePath";
  readonly recovery_hint: {
    rejected_argument: { argument: "storePath"; value: unknown };
    expected: { kind: "non_empty_string"; min_length: 1 };
    retry_with: { argument: "storePath"; value_placeholder: "<storePath>" };
  };

  constructor(storePath: unknown) {
    super("Invalid argument: Invalid storePath");
    this.name = "StorePathArgumentError";
    this.recovery_hint = {
      rejected_argument: { argument: "storePath", value: storePath },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { argument: "storePath", value_placeholder: "<storePath>" }
    };
  }
}

class StoreRepairArgumentError extends Error {
  readonly recommended_action = "retry init with a boolean repair value";
  readonly recovery_hint: {
    operation_contract: typeof INIT_OPERATION_CONTRACT_SOURCE;
    rejected_argument: { argument: "repair"; value: unknown };
    expected: { kind: "boolean" };
    argument_sources: { repair: typeof INIT_REPAIR_ARGUMENT_SOURCE };
    retry_with: { argument: "repair"; value_placeholder: true };
  };

  constructor(repair: unknown) {
    super("Invalid argument: Invalid repair");
    this.name = "StoreRepairArgumentError";
    this.recovery_hint = {
      operation_contract: INIT_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "repair", value: repair },
      expected: { kind: "boolean" },
      argument_sources: {
        repair: INIT_REPAIR_ARGUMENT_SOURCE
      },
      retry_with: { argument: "repair", value_placeholder: true }
    };
  }
}

export function validateStorePath(storePath: unknown): asserts storePath is string {
  if (typeof storePath !== "string" || storePath.length === 0) {
    throw new StorePathArgumentError(storePath);
  }
}

function validateInitializeStoreOptions(options: InitializeStoreOptions): void {
  if (options.repair !== undefined && typeof options.repair !== "boolean") {
    throw new StoreRepairArgumentError(options.repair);
  }
}

async function ensureStoreDirectories(storePath: string): Promise<void> {
  for (const name of ["events", "snapshots", "indexes", "state"]) {
    const dir = join(storePath, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitkeep"), "", "utf8");
  }
}

export async function readStoreConfig(storePath: string): Promise<StoreConfig> {
  validateStorePath(storePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(storePath, "config.json"), "utf8")) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid store config: ${join(storePath, "config.json")}: ${message}`);
  }
  const result = storeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid store config: ${join(storePath, "config.json")}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function initializeStore(
  storePath: string,
  options: InitializeStoreOptions = {}
): Promise<InitializeStoreResult> {
  validateStorePath(storePath);
  validateInitializeStoreOptions(options);
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => createId("device"));
  await mkdir(storePath, { recursive: true });
  await ensureStoreDirectories(storePath);

  let existing: StoreConfig | undefined;
  try {
    existing = await readStoreConfig(storePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      existing = undefined;
    } else if (options.repair && error instanceof Error && error.message.startsWith("Invalid store config:")) {
      existing = undefined;
    } else {
      throw error;
    }
  }

  const timestamp = now();
  const config: StoreConfig = {
    store_version: 1,
    device_id: existing?.device_id ?? id(),
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  };
  const result = storeConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid store config: ${z.prettifyError(result.error)}`);
  }

  await writeFile(join(storePath, "config.json"), `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
  return {
    config: result.data,
    store: storePath,
    artifacts: {
      config: "config.json"
    },
    selection_sources: STORE_INIT_SELECTION_SOURCES
  };
}
