import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore, withTempStore } from "../helpers/temp-store.js";

describe("event store", () => {
  function checkpointStoreEvent(eventId: string) {
    return {
      event_id: eventId, op: "upsert_record" as const, created_at: "2026-05-27T00:00:00.000Z",
      source: { client: "test", device_id: "device_a" },
      record: { id: eventId.replace("evt_", "rec_"), kind: "session_summary" as const, type: "checkpoint", scope: "project" as const,
        project_id: "project-a", tags: [], content: { text: "complete", format: "json" as const }, state: "candidate" as const,
        confidence: 0.5, priority: "normal" as const, visibility: "active" as const, created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z", source: { client: "test", device_id: "device_a" } }
    };
  }
  it("atomically appends a global event once and returns the persisted event to losers", async () => {
    await withInitializedTempStore(async (storePath) => {
      const event = {
        event_id: "evt_checkpoint_abc123",
        op: "upsert_record" as const,
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_checkpoint_abc123",
          kind: "session_summary" as const,
          type: "checkpoint",
          scope: "project" as const,
          project_id: "project-a",
          tags: ["checkpoint"],
          content: { text: "checkpoint", format: "json" as const },
          state: "candidate" as const,
          confidence: 0.5,
          priority: "normal" as const,
          visibility: "active" as const,
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test", device_id: "device_a" }
        }
      };

      const [first, second] = await Promise.all([
        appendEventIfAbsent(storePath, event),
        appendEventIfAbsent(storePath, { ...event, source: { ...event.source, device_id: "device_b" } })
      ]);

      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.event).toEqual(second.event);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("publishes only complete temp files and ignores orphan temps", async () => {
    await withInitializedTempStore(async (storePath) => {
      const event = {
        event_id: "evt_checkpoint_publish",
        op: "upsert_record" as const,
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_checkpoint_publish", kind: "session_summary" as const, type: "checkpoint", scope: "project" as const,
          project_id: "project-a", tags: ["checkpoint"], content: { text: "complete", format: "json" as const },
          state: "candidate" as const, confidence: 0.5, priority: "normal" as const, visibility: "active" as const,
          created_at: "2026-05-27T00:00:00.000Z", updated_at: "2026-05-27T00:00:00.000Z", source: { client: "test", device_id: "device_a" }
        }
      };
      const tempDir = join(storePath, "state", "event-writes");
      await mkdir(tempDir, { recursive: true });
      await writeFile(join(tempDir, "orphan.tmp"), "{partial", "utf8");
      let releasePublish!: () => void;
      const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
      let tempReady!: () => void;
      const tempReadyPromise = new Promise<void>((resolve) => { tempReady = resolve; });

      const paused = appendEventIfAbsent(storePath, event, { before_publish: async () => { tempReady(); await publishGate; } });
      await tempReadyPromise;
      const competitor = appendEventIfAbsent(storePath, event);
      releasePublish();
      const results = await Promise.all([paused, competitor]);

      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(results[0]?.event).toEqual(results[1]?.event);
      expect((await readdir(tempDir)).filter((name) => name !== "orphan.tmp")).toEqual([]);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("reports a stable error for corrupt existing idempotent events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const finalDir = join(storePath, "events", "idempotent");
      await mkdir(finalDir, { recursive: true });
      await writeFile(join(finalDir, "evt_checkpoint_corrupt.json"), "{partial", "utf8");
      const event = {
        event_id: "evt_checkpoint_corrupt", op: "upsert_record" as const, created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: { id: "rec_checkpoint_corrupt", kind: "session_summary" as const, type: "checkpoint", scope: "project" as const,
          project_id: "project-a", tags: [], content: { text: "complete", format: "json" as const }, state: "candidate" as const,
          confidence: 0.5, priority: "normal" as const, visibility: "active" as const, created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z", source: { client: "test", device_id: "device_a" } }
      };

      await expect(appendEventIfAbsent(storePath, event)).rejects.toThrow("Corrupt idempotent event: evt_checkpoint_corrupt");
    });
  });

  it("reports durable publication after syncing the final directory", async () => {
    await withInitializedTempStore(async (storePath) => {
      let directorySynced = false;
      const event = checkpointStoreEvent("evt_checkpoint_durable");
      const result = await appendEventIfAbsent(storePath, event, {
        fs: {
          open: async (path, flags) => {
            if (flags === "r" && path.endsWith(join("events", "idempotent"))) {
              return { sync: async () => { directorySynced = true; }, close: async () => undefined };
            }
            const { open } = await import("node:fs/promises");
            return open(path, flags);
          }
        }
      });

      expect(directorySynced).toBe(true);
      expect(result).toMatchObject({ created: true, durable: true });
    });
  });

  it("preserves a published result when temp cleanup fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await appendEventIfAbsent(storePath, checkpointStoreEvent("evt_checkpoint_cleanup"), {
        fs: { unlink: async () => { const error = new Error("cleanup failed") as NodeJS.ErrnoException; error.code = "EIO"; throw error; } }
      });

      expect(result).toMatchObject({
        created: true,
        durable: true,
        warnings: [{ code: "IDEMPOTENT_EVENT_TEMP_CLEANUP_FAILED", reason: "cleanup failed" }]
      });
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each(["EPERM", "EACCES", "ENOTSUP", "EXDEV"])("rejects unsupported atomic publish with %s", async (code) => {
    await withInitializedTempStore(async (storePath) => {
      const error = new Error("link unsupported") as NodeJS.ErrnoException;
      error.code = code;
      await expect(appendEventIfAbsent(storePath, checkpointStoreEvent(`evt_checkpoint_${code.toLowerCase()}`), {
        fs: { link: async () => { throw error; } }
      })).rejects.toThrow(`Atomic idempotent event publish unsupported: ${code}`);
    });
  });

  it("reports non-durable publication when final directory sync fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await appendEventIfAbsent(storePath, checkpointStoreEvent("evt_checkpoint_dirsync"), {
        fs: {
          open: async (path, flags) => {
            if (flags === "r" && path.endsWith(join("events", "idempotent"))) {
              return { sync: async () => { throw new Error("directory sync failed"); }, close: async () => undefined };
            }
            const { open } = await import("node:fs/promises");
            return open(path, flags);
          }
        }
      });

      expect(result).toMatchObject({
        created: true,
        durable: false,
        warnings: [{ code: "IDEMPOTENT_EVENT_DIRECTORY_SYNC_FAILED", reason: "directory sync failed" }]
      });
    });
  });
  async function expectInvalidStorePath(action: () => Promise<unknown>, value: unknown): Promise<void> {
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
    expect(envelope.error.recommended_action).toBe("retry store operation with a non-empty storePath");
    expect(envelope.error.recovery_hint).toEqual({
      rejected_argument: { argument: "storePath", value },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { argument: "storePath", value_placeholder: "<storePath>" }
    });
  }

  async function expectInvalidEventPathComponent(action: () => Promise<unknown>, componentName: string, value: string): Promise<void> {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }

    if (!caught) {
      throw new Error("Expected invalid event path component");
    }

    const envelope = toErrorEnvelope(caught);
    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error.message).toContain(`Invalid event path component: ${componentName}`);
    expect(envelope.error.recommended_action).toBe("retry with safe event path components");
    expect(envelope.error.recovery_hint).toEqual({
      rejected_argument: { argument: componentName, value },
      expected: {
        kind: "safe_path_component",
        disallowed_values: [".", ".."],
        disallowed_characters: ["/", "\\", "\\0"]
      },
      retry_with: { argument: componentName, value_placeholder: `<${componentName}>` }
    });
  }

  it("requires store initialization before reading or appending events", async () => {
    await withTempStore(async (storePath) => {
      const uninitialized = join(storePath, "uninitialized");

      await expect(readEvents(uninitialized)).rejects.toThrow(/Store not initialized/);
      await expect(appendEvent(uninitialized, {
        event_id: "evt_missing_store",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_missing_store",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Should not write before init.", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      })).rejects.toThrow(/Store not initialized/);
    });
  });

  it("rejects invalid store paths before checking initialization", async () => {
    await expectInvalidStorePath(() => readEvents(""), "");
    await expectInvalidStorePath(() => readEvents(null as never), null);
    await expectInvalidStorePath(() => appendEvent("", {
      event_id: "evt_invalid_store_path",
      op: "upsert_record",
      created_at: "2026-05-27T00:00:00.000Z",
      source: { client: "test", device_id: "device_a" },
      record: {
        id: "rec_invalid_store_path",
        kind: "memory",
        type: "decision",
        scope: "project",
        tags: [],
        content: { text: "Should reject path before initialization checks.", format: "text" },
        state: "canonical",
        confidence: 1,
        priority: "normal",
        visibility: "active",
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" }
      }
    }), "");
    await expectInvalidStorePath(() => appendEvent(123 as never, {
      event_id: "evt_invalid_store_path_number",
      op: "upsert_record",
      created_at: "2026-05-27T00:00:00.000Z",
      source: { client: "test", device_id: "device_a" },
      record: {
        id: "rec_invalid_store_path_number",
        kind: "memory",
        type: "decision",
        scope: "project",
        tags: [],
        content: { text: "Should reject non-string path before initialization checks.", format: "text" },
        state: "canonical",
        confidence: 1,
        priority: "normal",
        visibility: "active",
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" }
      }
    }), 123);
  });

  it("appends events under device and month partitions", async () => {
    await withInitializedTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "A", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      });

      const events = await readEvents(storePath);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_id).toBe("evt_1");
    });
  });

  it("uses the store device id for events without an explicit device id", async () => {
    await withInitializedTempStore(async (storePath) => {
      const config = JSON.parse(await readFile(join(storePath, "config.json"), "utf8")) as { device_id: string };

      const path = await appendEvent(storePath, {
        event_id: "evt_default_device",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "cli" },
        record: {
          id: "rec_default_device",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Use store device partitions.", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "cli" }
        }
      });

      expect(path).toContain(join("events", config.device_id, "2026-05", "evt_default_device.json"));
      const [event] = await readEvents(storePath);
      expect(event?.source.device_id).toBe(config.device_id);
      if (event?.op === "upsert_record") {
        expect(event.record.source.device_id).toBe(config.device_id);
      }
    });
  });

  it("rejects invalid event files while reading", async () => {
    await withInitializedTempStore(async (storePath) => {
      const path = join(storePath, "events", "device_default", "2026-05", "evt_invalid.json");
      await mkdir(join(storePath, "events", "device_default", "2026-05"), { recursive: true });
      await writeFile(path, `${JSON.stringify({
        event_id: "evt_invalid",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_bad",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Bad", format: "text" },
          state: "published",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      })}\n`, "utf8");

      await expect(readEvents(storePath)).rejects.toThrow(/Invalid event/);
    });
  });

  it("rejects invalid events before appending", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(appendEvent(storePath, {
        event_id: "evt_invalid",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_bad",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Bad", format: "text" },
          state: "published",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      } as never)).rejects.toThrow(/Invalid event/);
    });
  });

  it("rejects unsafe event path components before writing files", async () => {
    await withInitializedTempStore(async (storePath) => {
      await withTempStore(async (root) => {
        const outsidePath = join(root, "evt_escape.json");

        const unsafeEventId = `..${outsidePath}`;
        await expectInvalidEventPathComponent(() => appendEvent(storePath, {
          event_id: unsafeEventId,
          op: "upsert_record",
          created_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test", device_id: "device_a" },
          record: {
            id: "rec_unsafe_event_id",
            kind: "memory",
            type: "decision",
            scope: "project",
            tags: [],
            content: { text: "Unsafe event ids must not affect file paths.", format: "text" },
            state: "canonical",
            confidence: 1,
            priority: "normal",
            visibility: "active",
            created_at: "2026-05-27T00:00:00.000Z",
            updated_at: "2026-05-27T00:00:00.000Z",
            source: { client: "test" }
          }
        }), "event_id", unsafeEventId);

        const unsafeDeviceId = "../device_escape";
        await expectInvalidEventPathComponent(() => appendEvent(storePath, {
          event_id: "evt_unsafe_device",
          op: "upsert_record",
          created_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test", device_id: unsafeDeviceId },
          record: {
            id: "rec_unsafe_device",
            kind: "memory",
            type: "decision",
            scope: "project",
            tags: [],
            content: { text: "Unsafe device ids must not affect file paths.", format: "text" },
            state: "canonical",
            confidence: 1,
            priority: "normal",
            visibility: "active",
            created_at: "2026-05-27T00:00:00.000Z",
            updated_at: "2026-05-27T00:00:00.000Z",
            source: { client: "test" }
          }
        }), "source.device_id", unsafeDeviceId);

        await expect(readFile(outsidePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readEvents(storePath)).toHaveLength(0);
      });
    });
  });

  it("rejects unredacted sensitive events before appending", async () => {
    await withInitializedTempStore(async (storePath) => {
      let caught: unknown;
      try {
        await appendEvent(storePath, {
        event_id: "evt_secret",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_secret",
          kind: "memory",
          type: "warning",
          scope: "project",
          tags: [],
          content: {
            text: "Review deployment settings.",
            format: "text",
            token: "abcdef1234567890"
          },
          state: "quarantined",
          confidence: 0.5,
          priority: "normal",
          visibility: "quarantined",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
        });
      } catch (error) {
        caught = error;
      }

      if (!caught) {
        throw new Error("Expected sensitive content rejection");
      }

      const envelope = toErrorEnvelope(caught);
      expect(envelope.error.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect(envelope.error.recovery_hint).toMatchObject({
        rejected_content: { sensitive: true, value_included: false },
        expected: { kind: "redacted_content", redaction_token: "[REDACTED_SECRET]" }
      });
      expect(JSON.stringify(envelope.error.recovery_hint)).not.toContain("abcdef1234567890");

      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });
});
