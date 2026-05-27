import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
