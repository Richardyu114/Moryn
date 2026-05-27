import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { initializeStore, readStoreConfig } from "../../src/core/config.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("store config", () => {
  async function expectInvalidStorePath(action: () => Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }

    if (!caught) {
      throw new Error("Expected invalid store path");
    }

    const envelope = toErrorEnvelope(caught);
    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error.message).toContain("Invalid storePath");
  }

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
      await expect(readFile(join(storePath, "state", ".gitkeep"), "utf8")).resolves.toBe("");
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

  it("rejects invalid store paths before writing local store files", async () => {
    await withTempStore(async (root) => {
      const sentinel = join(root, "sentinel");
      await expectInvalidStorePath(() => initializeStore(""));
      await expectInvalidStorePath(() => initializeStore(null as never));
      await expectInvalidStorePath(() => readStoreConfig(""));
      await expectInvalidStorePath(() => readStoreConfig(123 as never));

      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects generated invalid store config before writing config.json", async () => {
    await withTempStore(async (storePath) => {
      await expect(initializeStore(storePath, {
        now: () => "not-a-date",
        id: () => ""
      })).rejects.toThrow(/Invalid store config/);

      await expect(access(join(storePath, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects malformed existing config during init", async () => {
    await withTempStore(async (storePath) => {
      await mkdir(storePath, { recursive: true });
      await writeFile(join(storePath, "config.json"), "{\"store_version\":", "utf8");

      await expect(initializeStore(storePath)).rejects.toThrow(/Invalid store config/);
    });
  });
});
