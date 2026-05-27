import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeStore, readStoreConfig } from "../../src/core/config.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("store config", () => {
  it("initializes config and local store directories", async () => {
    await withTempStore(async (storePath) => {
      const result = await initializeStore(storePath, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_test"
      });

      expect(result.config).toEqual({
        store_version: 1,
        device_id: "device_test",
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z"
      });
      await expect(readFile(join(storePath, "events", ".gitkeep"), "utf8")).resolves.toBe("");
      await expect(readFile(join(storePath, "snapshots", ".gitkeep"), "utf8")).resolves.toBe("");
      await expect(readFile(join(storePath, "indexes", ".gitkeep"), "utf8")).resolves.toBe("");
    });
  });

  it("preserves existing device identity on repeated init", async () => {
    await withTempStore(async (storePath) => {
      await mkdir(storePath, { recursive: true });
      await initializeStore(storePath, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_first"
      });

      const result = await initializeStore(storePath, {
        now: () => "2026-05-28T00:00:00.000Z",
        id: () => "device_second"
      });

      expect(result.config.device_id).toBe("device_first");
      expect(result.config.created_at).toBe("2026-05-27T00:00:00.000Z");
      expect(result.config.updated_at).toBe("2026-05-28T00:00:00.000Z");
      await expect(readStoreConfig(storePath)).resolves.toEqual(result.config);
    });
  });
});
