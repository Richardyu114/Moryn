import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { appendEvent, readEvents, withStoreLock } from "../../src/core/store.js";
import { withInitializedTempStore, withTempStore } from "../helpers/temp-store.js";

describe("event store", () => {
  it.each(["", "   ", ".", "..", "bad/name", "bad\\name"])("rejects unsafe store lock name %j", async (lockName) => {
    await withInitializedTempStore(async (storePath) => {
      await expect(withStoreLock(storePath, lockName, async () => undefined)).rejects.toThrow(/lock_name|non-empty/i);
    });
  });

  it("releases store locks after the protected function throws", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(withStoreLock(storePath, "checkpoint", async () => {
        throw new Error("boom");
      })).rejects.toThrow("boom");

      await expect(withStoreLock(storePath, "checkpoint", async () => "recovered")).resolves.toBe("recovered");
    });
  });

  it("removes an obviously stale store lock", async () => {
    await withInitializedTempStore(async (storePath) => {
      const lockPath = join(storePath, "state", "locks", "checkpoint");
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "stale-owner", heartbeat_at: new Date(0).toISOString() }), "utf8");
      await utimes(join(lockPath, "owner.json"), new Date(0), new Date(0));

      await expect(withStoreLock(storePath, "checkpoint", async () => "acquired", { stale_ms: 10 })).resolves.toBe("acquired");
    });
  });

  it("heartbeats a slow owner so a waiter cannot enter after stale_ms", async () => {
    await withInitializedTempStore(async (storePath) => {
      let firstActive = false;
      let overlapped = false;
      const first = withStoreLock(storePath, "checkpoint", async () => {
        firstActive = true;
        await new Promise((resolve) => setTimeout(resolve, 120));
        firstActive = false;
        return "first";
      }, { stale_ms: 40, heartbeat_ms: 10, poll_ms: 5, timeout_ms: 500 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const second = withStoreLock(storePath, "checkpoint", async () => {
        overlapped = firstActive;
        return "second";
      }, { stale_ms: 40, heartbeat_ms: 10, poll_ms: 5, timeout_ms: 500 });

      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");
      expect(overlapped).toBe(false);
    });
  });

  it("does not remove a replacement owner during release", async () => {
    await withInitializedTempStore(async (storePath) => {
      const lockPath = join(storePath, "state", "locks", "checkpoint");
      await withStoreLock(storePath, "checkpoint", async () => {
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "replacement", heartbeat_at: new Date().toISOString() }), "utf8");
      }, { stale_ms: 1_000, heartbeat_ms: 100 });

      expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))).toMatchObject({ token: "replacement" });
      await rm(lockPath, { recursive: true, force: true });
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
