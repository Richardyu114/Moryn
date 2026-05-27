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

async function ensureStoreDirectories(storePath: string): Promise<void> {
  for (const name of ["events", "snapshots", "indexes"]) {
    const dir = join(storePath, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitkeep"), "", "utf8");
  }
}

export async function readStoreConfig(storePath: string): Promise<StoreConfig> {
  const raw = JSON.parse(await readFile(join(storePath, "config.json"), "utf8")) as unknown;
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
  } catch {
    existing = undefined;
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
