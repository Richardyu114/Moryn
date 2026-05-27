import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore } from "../../src/core/config.js";

export async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withInitializedTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  return withTempStore(async (storePath) => {
    await initializeStore(storePath, {
      now: () => "2026-05-27T00:00:00.000Z",
      id: () => "device_test"
    });
    return fn(storePath);
  });
}
