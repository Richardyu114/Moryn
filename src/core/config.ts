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

export interface InitializeStoreOptions {
  now?: () => string;
  id?: () => string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function ensureStoreDirectories(storePath: string): Promise<void> {
  for (const name of ["events", "snapshots", "indexes", "state"]) {
    const dir = join(storePath, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitkeep"), "", "utf8");
  }
}

export async function readStoreConfig(storePath: string): Promise<StoreConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(storePath, "config.json"), "utf8")) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid store config: ${message}`);
  }
  const result = storeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid store config: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function initializeStore(storePath: string, options: InitializeStoreOptions = {}): Promise<{ config: StoreConfig; store: string }> {
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

  await writeFile(join(storePath, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, store: storePath };
}
