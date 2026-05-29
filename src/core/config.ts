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

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function validateStorePath(storePath: unknown): asserts storePath is string {
  if (typeof storePath !== "string" || storePath.length === 0) {
    throw new Error("Invalid argument: Invalid storePath");
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

export async function initializeStore(storePath: string, options: InitializeStoreOptions = {}): Promise<InitializeStoreResult> {
  validateStorePath(storePath);
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
