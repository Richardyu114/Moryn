import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("core engine", () => {
  it("writes, recalls, revises, and promotes records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use GitHub sync.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await engine.revise({ record_id: written.record.id, patch: { "content.text": "Use private GitHub sync." }, reason: "Clarify privacy" });
      await engine.promote({ record_id: written.record.id, target_state: "canonical", reason: "User confirmed" });

      const recall = await engine.recall({ query: "github sync", project_id: "memora", limit: 5 });
      expect(recall.results[0]?.record.content.text).toBe("Use private GitHub sync.");
      expect(recall.results[0]?.record.state).toBe("canonical");
    });
  });

  it("preserves provenance on writes and canonical promotion", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use event provenance.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "sess_1" },
        provenance: {
          derived_from: ["rec_source"],
          reason: "Derived from the design discussion."
        }
      });

      expect(written.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "Derived from the design discussion.",
        method: "agent-proposed"
      });

      await engine.promote({
        record_id: written.record.id,
        target_state: "canonical",
        reason: "User confirmed this decision.",
        source: { client: "user" }
      });

      const recall = await engine.recall({ record_ids: [written.record.id] });
      expect(recall.results[0]?.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "User confirmed this decision.",
        method: "user-confirmed",
        promoted_at: "2026-05-27T00:00:00.001Z"
      });
    });
  });

  it("orders rapid same-millisecond mutations after the record creation event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const ids = ["rec_1", "evt_z_upsert", "evt_a_revise"];
      const engine = createEngine({
        storePath,
        now: () => "2026-05-27T00:00:00.000Z",
        id: (prefix) => ids.shift() ?? `${prefix}_extra`
      });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use old sync wording", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "Use private Git sync" },
        reason: "Clarified wording",
        source: { client: "test" }
      });

      const recall = await engine.recall({ record_ids: [written.record.id] });
      expect(recall.results[0]?.record.content.text).toBe("Use private Git sync");
    });
  });

  it("quarantines sensitive content on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "API_KEY=sk-1234567890abcdef", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
    });
  });

  it("quarantines authorization headers on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Authorization: Bearer ghp_1234567890abcdef", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "memora" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "Authorization", project_id: "memora" })).results).toHaveLength(0);

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("ghp_1234567890abcdef");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("rejects invalid core write arguments before appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      async function expectInvalidArgument(input: Parameters<typeof engine.write>[0], message: string): Promise<void> {
        try {
          await engine.write(input);
          throw new Error("Expected write to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
      }

      await expectInvalidArgument(null as never, "Invalid write input");
      await expectInvalidArgument({
        kind: "note" as never,
        type: "decision",
        scope: "project",
        content: { text: "Invalid kind.", format: "text" },
        source: { client: "test" }
      }, "Invalid kind");
      await expectInvalidArgument({
        kind: "memory",
        type: "",
        scope: "project",
        content: { text: "Invalid type.", format: "text" },
        source: { client: "test" }
      }, "Invalid type");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid confidence.", format: "text" },
        confidence: 2,
        source: { client: "test" }
      }, "Invalid confidence");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        tags: ["valid", 123] as never,
        content: { text: "Invalid tags.", format: "text" },
        source: { client: "test" }
      }, "Invalid tags");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        tags: [""],
        content: { text: "Empty tag.", format: "text" },
        source: { client: "test" }
      }, "Invalid tags");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: "Invalid content." as never,
        source: { client: "test" }
      }, "Invalid content");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "", format: "text" },
        source: { client: "test" }
      }, "Invalid content.text");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid format.", format: "markdown" as never },
        source: { client: "test" }
      }, "Invalid content.format");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid source.", format: "text" },
        source: { client: "" }
      }, "Invalid source.client");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid confirmed.", format: "text" },
        source: { client: "test" },
        confirmed: "yes" as never
      }, "Invalid confirmed");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid provenance.", format: "text" },
        source: { client: "test" },
        provenance: { method: "imported" } as never
      }, "Invalid provenance");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Empty provenance source.", format: "text" },
        source: { client: "test" },
        provenance: { derived_from: [""] }
      }, "Invalid provenance.derived_from");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Empty provenance reason.", format: "text" },
        source: { client: "test" },
        provenance: { reason: "" }
      }, "Invalid provenance.reason");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Invalid provenance timestamp.", format: "text" },
        source: { client: "test" },
        provenance: { promoted_at: "not-a-date" }
      }, "Invalid provenance.promoted_at");
      await expectInvalidArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Date-only provenance timestamp.", format: "text" },
        source: { client: "test" },
        provenance: { promoted_at: "2026-05-27" }
      }, "Invalid provenance.promoted_at");

      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("quarantines records revised with sensitive content", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Review auth middleware before release.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const revised = await engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "Authorization: Bearer ghp_1234567890abcdef" },
        reason: "Pasted request header",
        source: { client: "test" }
      });

      expect(revised.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "memora" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "Authorization", project_id: "memora" })).results).toHaveLength(0);

      const quarantined = await engine.recall({
        record_ids: [written.record.id],
        states: ["quarantined"],
        project_id: "memora"
      });
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
      expect(quarantined.results[0]?.record.visibility).toBe("quarantined");
      expect(quarantined.results[0]?.record.content.text).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("ghp_1234567890abcdef");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("rejects revisions that attempt to change managed record state fields", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use promotion events for state transitions.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await expect(engine.revise({
        record_id: written.record.id,
        patch: { state: "canonical" },
        reason: "Bypass promotion",
        source: { client: "test" }
      })).rejects.toThrow(/managed field/);

      const recall = await engine.recall({ record_ids: [written.record.id], states: ["candidate"] });
      expect(recall.results[0]?.record.state).toBe("candidate");
    });
  });

  it("rejects revisions that would produce an invalid record as invalid arguments", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Keep replayable records valid after revision.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      const originalEvents = await readEvents(storePath);

      try {
        await engine.revise({
          record_id: written.record.id,
          patch: { confidence: 2 },
          reason: "Invalid confidence",
          source: { client: "test" }
        });
        throw new Error("Expected invalid revision patch to reject");
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        expect(envelope.error.code).toBe("INVALID_ARGUMENT");
        expect(envelope.error.message).toContain("Invalid patch");
      }
      await expect(engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "" },
        reason: "Invalid content text",
        source: { client: "test" }
      })).rejects.toThrow(/Invalid patch/);

      const unchanged = await engine.recall({ record_ids: [written.record.id] });
      expect(unchanged.results[0]?.record.confidence).toBe(0.5);
      expect(unchanged.results[0]?.record.content.text).toBe("Keep replayable records valid after revision.");
      expect(await readEvents(storePath)).toHaveLength(originalEvents.length);
    });
  });

  it("rejects revisions that would create unconfirmed canonical conflicts", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await expect(engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "Agent inferred this replacement",
        source: { client: "agent" }
      })).rejects.toThrow(/conflicting canonical memory requires explicit user confirmation/);

      const unchanged = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(unchanged.results[0]?.record.content.text).toBe("Use private Git remotes.");
      expect(unchanged.results[0]?.record.type).toBe("warning");
      expect(unchanged.results[0]?.record.conflict).toBeUndefined();
      expect(existing.record.id).toBeTruthy();
    });
  });

  it("records confirmed canonical revision conflicts without rewriting history", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "User confirmed the replacement",
        source: { client: "agent" },
        confirmed: true
      });

      const revised = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(revised.results[0]?.record.type).toBe("decision");
      expect(revised.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
      expect(revised.results[0]?.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });
    });
  });

  it("clears canonical revision conflicts after a confirmed non-conflicting revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "User confirmed the replacement",
        source: { client: "agent" },
        confirmed: true
      });
      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { "content.text": "Use append-only JSON events." },
        reason: "User resolved the conflict",
        source: { client: "agent" }
      });

      const resolved = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(resolved.results[0]?.record.content.text).toBe("Use append-only JSON events.");
      expect(resolved.results[0]?.record.conflict).toBeUndefined();
    });
  });

  it("scans full structured content for sensitive values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: {
          text: "Review deployment settings.",
          format: "text",
          header: "Authorization: Bearer ghp_1234567890abcdef"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");

      const clean = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Review deployment settings.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      const revised = await engine.revise({
        record_id: clean.record.id,
        patch: { "content.header": "Authorization: Bearer ghp_abcdef1234567890" },
        reason: "Added request sample",
        source: { client: "test" }
      });

      expect(revised.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      const quarantined = await engine.recall({ record_ids: [clean.record.id], states: ["quarantined"] });
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
    });
  });

  it("redacts sensitive structured values detected by field names", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: {
          text: "Review deployment settings.",
          format: "text",
          token: "abcdef1234567890"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.content.token).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("abcdef1234567890");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("quarantines cookie headers on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "Cookie: session=abcdef1234567890; csrf=ghijklmnop123456", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.recall({ query: "session", project_id: "memora" })).results).toHaveLength(0);
    });
  });

  it("quarantines pasted env files on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: {
          text: [
            "DATABASE_URL=postgres://memora:secret@localhost:5432/memora",
            "REDIS_URL=redis://localhost:6379",
            "SESSION_SECRET=abcdefghijklmnopqrstuvwxyz",
            "WEBHOOK_TOKEN=whsec_1234567890abcdef"
          ].join("\n"),
          format: "text"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "memora" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "DATABASE_URL", project_id: "memora" })).results).toHaveLength(0);
    });
  });

  it("keeps high-risk canonical writes as candidates until user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const soul = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Always prefer terse answers.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });
      const globalSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Deploy production after smoke tests.", format: "text" },
        state: "canonical",
        source: { client: "mcp" }
      });
      const securityRule = await engine.write({
        kind: "memory",
        type: "security_rule",
        scope: "project",
        project_id: "memora",
        content: { text: "Agents may rotate production credentials.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(soul.record.state).toBe("candidate");
      expect(soul.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(globalSkill.record.state).toBe("candidate");
      expect(globalSkill.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(securityRule.record.state).toBe("candidate");
      expect(securityRule.warning?.code).toBe("CONFIRMATION_REQUIRED");

      const userConfirmed = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer direct engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      expect(userConfirmed.record.state).toBe("canonical");
      expect(userConfirmed.warning).toBeUndefined();

      const explicitlyConfirmed = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Run release checks before publishing.", format: "text" },
        state: "canonical",
        source: { client: "cli" },
        confirmed: true
      });
      expect(explicitlyConfirmed.record.state).toBe("canonical");
      expect(explicitlyConfirmed.warning).toBeUndefined();
    });
  });

  it("marks semantic conflicts and requires confirmation before conflicting canonical writes", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync", "storage"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const conflicting = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync", "storage"],
        content: { text: "Use SQLite as the source of truth.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(conflicting.record.state).toBe("candidate");
      expect(conflicting.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(conflicting.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });

      const confirmed = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync", "storage"],
        content: { text: "Use SQLite for local indexes only.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      expect(confirmed.record.state).toBe("canonical");
      expect(confirmed.record.conflict?.with).toContain(existing.record.id);
    });
  });

  it("rejects conflicting canonical promotion without user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const candidate = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use SQLite as the source of truth.", format: "text" },
        state: "candidate",
        source: { client: "agent" }
      });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      expect(candidate.record.conflict).toBeUndefined();

      await expect(engine.promote({
        record_id: candidate.record.id,
        target_state: "canonical",
        reason: "Agent inferred this replacement",
        source: { client: "agent" }
      })).rejects.toThrow(/conflicting canonical memory requires explicit user confirmation/);

      const stillCandidate = await engine.recall({ record_ids: [candidate.record.id], states: ["candidate"] });
      expect(stillCandidate.results[0]?.record.state).toBe("candidate");

      await engine.promote({
        record_id: candidate.record.id,
        target_state: "canonical",
        reason: "User confirmed",
        source: { client: "cli" },
        confirmed: true
      });

      const confirmed = await engine.recall({ record_ids: [candidate.record.id] });
      expect(confirmed.results[0]?.record.state).toBe("canonical");
      expect(confirmed.results[0]?.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });
    });
  });

  it("rejects high-risk canonical promotion without user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const soul = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer very terse answers.", format: "text" },
        state: "candidate",
        source: { client: "codex" }
      });

      await expect(engine.promote({
        record_id: soul.record.id,
        target_state: "canonical",
        reason: "Agent inferred this preference",
        source: { client: "agent" }
      })).rejects.toThrow(/Confirmation required/);

      const stillCandidate = await engine.recall({ record_ids: [soul.record.id], states: ["candidate"] });
      expect(stillCandidate.results[0]?.record.state).toBe("candidate");

      await engine.promote({
        record_id: soul.record.id,
        target_state: "canonical",
        reason: "User confirmed",
        source: { client: "cli" },
        confirmed: true
      });
      const confirmed = await engine.recall({ record_ids: [soul.record.id] });
      expect(confirmed.results[0]?.record.state).toBe("canonical");
      expect(confirmed.results[0]?.record.provenance?.method).toBe("user-confirmed");
    });
  });

  it("recalls with record id, kind, type, state, tag, and file filters", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => `2026-05-27T00:00:0${nextId}.000Z`, id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["auth", "src/auth.ts"],
        content: { text: "Auth middleware uses signed cookies.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Run npm test before release.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "other",
        tags: ["auth"],
        content: { text: "Unrelated project warning.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        record_ids: [decision.record.id],
        project_id: "memora",
        kinds: ["memory"],
        types: ["decision"],
        states: ["canonical"],
        tags: ["auth"],
        files: ["src/auth.ts"],
        limit: 5
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(decision.record.id);
      expect(recall.results[0]?.reason).toContain("record_id_match");
      expect(recall.results[0]?.reason).toContain("tag_match:auth");
      expect(recall.results[0]?.reason).toContain("file_match:src/auth.ts");
    });
  });

  it("recalls with explicit scope filtering", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "global",
        tags: ["policy"],
        content: { text: "Global policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["policy"],
        content: { text: "Project policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({ query: "policy", scopes: ["project"], project_id: "memora" });

      expect(recall.results.map((result) => result.record.content.text)).toEqual(["Project policy memory."]);
    });
  });

  it("recalls an explicit record id even when the current project context differs", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const otherProject = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "other",
        content: { text: "Other project decision retrieved by exact id.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        record_ids: [otherProject.record.id],
        project_id: "memora"
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(otherProject.record.id);
      expect(recall.results[0]?.reason).toContain("record_id_match");
    });
  });

  it("keeps raw agent notes out of default recall", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const note = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "Raw implementation detail should stay source material.", format: "text" },
        source: { client: "agent-a" }
      });

      expect((await engine.recall({ query: "implementation detail", project_id: "memora" })).results).toHaveLength(0);

      const explicit = await engine.recall({
        query: "implementation detail",
        project_id: "memora",
        states: ["raw"]
      });
      expect(explicit.results[0]?.record.id).toBe(note.record.id);
    });
  });

  it("builds boot context from trusted profile, project, skill, and recent records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z",
        "2026-05-27T00:04:00.000Z",
        "2026-05-27T00:05:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use append-only events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Do not include secrets in memory.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["memora"],
        content: { text: "Run tests before committing.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { text: "Unrelated global skill.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "Raw note should not boot.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora" });

      expect(boot.profile.soul.map((record) => record.content.text)).toEqual(["Prefer concise engineering updates."]);
      expect(boot.project.important_decisions.map((record) => record.content.text)).toEqual(["Use append-only events."]);
      expect(boot.project.warnings.map((record) => record.content.text)).toEqual(["Do not include secrets in memory."]);
      expect(boot.skills.map((record) => record.content.text)).toEqual(["Run tests before committing."]);
      expect(boot.skills.map((record) => record.content.text)).not.toContain("Unrelated global skill.");
      expect(boot.recent_changes.map((record) => record.content.text)).not.toContain("Raw note should not boot.");
      expect(boot.sync.cursor).toBe("2026-05-27T00:05:00.000Z");
    });
  });

  it("marks boot sync status when the sync provider reports remote updates", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        syncStatus: async () => ({ behind: 2 })
      });

      const boot = await engine.boot({ project_id: "memora" });

      expect(boot.sync.remote_has_updates).toBe(true);
    });
  });

  it("builds project summary, tech stack, and active goals from trusted project records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Memora is a local-first agent memory layer.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "memora",
        content: { text: "TypeScript", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "memora",
        content: { text: "Node.js", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "active_goal",
        scope: "project",
        project_id: "memora",
        content: { text: "Ship the first MCP-backed MVP.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "goal",
        scope: "project",
        project_id: "other",
        content: { text: "Other project goal.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "global",
        content: { text: "Global summary should not become project summary.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "memora",
        content: { text: "Candidate stack entry.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora" });

      expect(boot.project.summary).toBe("Memora is a local-first agent memory layer.");
      expect(boot.project.tech_stack).toEqual(["TypeScript", "Node.js"]);
      expect(boot.project.active_goals).toEqual(["Ship the first MCP-backed MVP."]);
    });
  });

  it("includes only important visible updates in boot recent changes", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const highConfidence = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Candidate release decision is ready for review.", format: "text" },
        state: "candidate",
        confidence: 0.9,
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Low confidence candidate should stay out.", format: "text" },
        state: "candidate",
        confidence: 0.4,
        source: { client: "test" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Session summary should stay out of boot recents.", format: "text" },
        state: "candidate",
        confidence: 0.9,
        source: { client: "test" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "Raw note should stay out of boot recents.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora" });

      expect(boot.recent_changes.map((record) => record.id)).toEqual([highConfidence.record.id]);
    });
  });

  it("adds configured default skill selectors to boot context", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const releaseSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { name: "safe-release", text: "Run tests, typecheck, build, then publish.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { name: "unrelated-skill", text: "Do unrelated work.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const boot = await engine.boot({ project_id: "memora", default_skills: ["safe-release", releaseSkill.record.id] });

      expect(boot.skills.map((record) => record.id)).toEqual([releaseSkill.record.id]);
      expect(boot.skills[0]?.content.text).toBe("Run tests, typecheck, build, then publish.");
    });
  });

  it("adds task-relevant trusted records to boot context when current task is provided", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const authDecision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["auth"],
        content: { text: "Auth token refresh uses rotating credentials.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Release skill from project config.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["release"],
        content: { text: "Release requires npm credentials.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        tags: ["auth"],
        content: { text: "Raw auth note should stay out of boot.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora", current_task: "fix auth token refresh" });

      expect(boot.task_relevant.map((record) => record.id)).toEqual([authDecision.record.id]);
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Release requires npm credentials.");
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Release skill from project config.");
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Raw auth note should stay out of boot.");
    });
  });

  it("reports refresh changes since a cursor with notice and interrupt importance", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:05:00.000Z",
        "2026-05-27T00:06:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Session finished.", format: "text" },
        state: "raw",
        source: { client: "test" }
      });
      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use MCP for agent access.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const blocker = await engine.write({
        kind: "memory",
        type: "blocker",
        scope: "project",
        project_id: "memora",
        content: { text: "Sync must not overwrite local events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({ project_id: "memora", cursor: "2026-05-27T00:00:00.000Z" });

      expect(refresh.cursor).toBe("2026-05-27T00:06:00.000Z");
      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({ record_id: decision.record.id, importance: "notice" }),
        expect.objectContaining({ record_id: blocker.record.id, importance: "interrupt" })
      ]);
    });
  });

  it("uses current task text to interrupt only on related blockers and warnings", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const authWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["auth"],
        content: { text: "Auth middleware has a token refresh blocker.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["release"],
        content: { text: "Release workflow needs npm credentials.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });

      const refresh = await engine.refresh({
        project_id: "memora",
        cursor: "2026-05-26T00:00:00.000Z",
        current_task: "fix auth token refresh"
      });

      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: authWarning.record.id,
          importance: "interrupt",
          reason: "current_task_match"
        })
      ]);
    });
  });

  it("keeps raw agent notes out of boot until promotion and preserves skill identity through revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const rawNote = await engine.write({
        kind: "agent_note",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use candidate workflow before boot exposure.", format: "text" },
        source: { client: "agent-a" }
      });
      const hiddenBoot = await engine.boot({ project_id: "memora" });
      expect(hiddenBoot.project.important_decisions).toHaveLength(0);

      await engine.promote({ record_id: rawNote.record.id, target_state: "canonical", reason: "User confirmed", source: { client: "user" } });
      const visibleBoot = await engine.boot({ project_id: "memora" });
      expect(visibleBoot.project.important_decisions.map((record) => record.id)).toEqual([rawNote.record.id]);

      const skill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Run tests.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.revise({
        record_id: skill.record.id,
        patch: { "content.text": "Run tests and typecheck." },
        reason: "Refined workflow",
        source: { client: "agent-b" }
      });
      const recall = await engine.recall({ record_ids: [skill.record.id], kinds: ["skill"] });

      expect(recall.results[0]?.record.id).toBe(skill.record.id);
      expect(recall.results[0]?.record.content.text).toBe("Run tests and typecheck.");
    });
  });

  it("archives, quarantines, links, and recalls hidden records only when explicitly requested", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use durable links between related records.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const superseded = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Old sync strategy.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const sensitive = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Internal warning that should be quarantined.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      await engine.link({
        record_id: decision.record.id,
        linked_record_id: superseded.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      });
      await engine.archive({ record_id: superseded.record.id, reason: "Superseded", source: { client: "test" } });
      await engine.quarantine({ record_id: sensitive.record.id, reason: "Needs review", source: { client: "test" } });

      expect((await engine.recall({ query: "Old sync", project_id: "memora" })).results).toHaveLength(0);
      expect((await engine.recall({ query: "Internal warning", project_id: "memora" })).results).toHaveLength(0);

      const archived = await engine.recall({ record_ids: [superseded.record.id], states: ["archived"], project_id: "memora" });
      const quarantined = await engine.recall({ record_ids: [sensitive.record.id], states: ["quarantined"], project_id: "memora" });
      const linked = await engine.recall({ record_ids: [decision.record.id], project_id: "memora" });

      expect(archived.results[0]?.record.state).toBe("archived");
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
      expect(linked.results[0]?.record.links).toEqual([
        {
          record_id: superseded.record.id,
          link_type: "supersedes",
          created_at: "2026-05-27T00:00:00.001Z"
        }
      ]);
    });
  });

  it("rejects invalid core result limits", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      await expect(engine.recall({ limit: 0 })).rejects.toThrow(/Invalid limit/);
      await expect(engine.refresh({ limit: 101 })).rejects.toThrow(/Invalid limit/);
      await expect(engine.listRecent(-1)).rejects.toThrow(/Invalid limit/);
    });
  });

  it("rejects invalid core read arguments", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      async function expectInvalidArgument(action: () => Promise<unknown>, message: string): Promise<void> {
        try {
          await action();
          throw new Error("Expected read to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
      }

      await expectInvalidArgument(() => engine.recall(null as never), "Invalid recall input");
      await expectInvalidArgument(() => engine.recall({ project_id: "" }), "Invalid project_id");
      await expectInvalidArgument(() => engine.recall({ query: 123 as never }), "Invalid query");
      await expectInvalidArgument(() => engine.recall({ record_ids: ["rec_1", 123] as never }), "Invalid record_ids");
      await expectInvalidArgument(() => engine.recall({ kinds: ["note"] as never }), "Invalid kinds");
      await expectInvalidArgument(() => engine.recall({ scopes: ["repository"] as never }), "Invalid scopes");
      await expectInvalidArgument(() => engine.recall({ states: ["published"] as never }), "Invalid states");
      await expectInvalidArgument(() => engine.recall({ tags: "sync" as never }), "Invalid tags");
      await expectInvalidArgument(() => engine.recall({ files: ["src/auth.ts", 123] as never }), "Invalid files");

      await expectInvalidArgument(() => engine.boot(null as never), "Invalid boot input");
      await expectInvalidArgument(() => engine.boot({ default_skills: ["release", 123] as never }), "Invalid default_skills");
      await expectInvalidArgument(() => engine.boot({ current_task: 123 as never }), "Invalid current_task");

      await expectInvalidArgument(() => engine.refresh(null as never), "Invalid refresh input");
      await expectInvalidArgument(() => engine.refresh({ cursor: 123 as never }), "Invalid cursor");
      await expectInvalidArgument(() => engine.refresh({ current_task: 123 as never }), "Invalid current_task");
    });
  });

  it("rejects mutation events that target missing records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Existing memory.", format: "text" },
        source: { client: "test" }
      });

      await expect(engine.revise({
        record_id: "rec_missing",
        patch: { "content.text": "No-op" },
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.promote({
        record_id: "rec_missing",
        target_state: "canonical",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.archive({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.quarantine({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: "rec_missing",
        linked_record_id: existing.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: existing.record.id,
        linked_record_id: "rec_missing",
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");

      const recall = await engine.recall({ record_ids: [existing.record.id] });
      expect(recall.results[0]?.record.links).toBeUndefined();
    });
  });

  it("rejects invalid core mutation arguments before appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Existing memory.", format: "text" },
        source: { client: "test" }
      });
      const linked = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Linked memory.", format: "text" },
        source: { client: "test" }
      });
      const originalEvents = await readEvents(storePath);

      async function expectInvalidArgument(action: () => Promise<unknown>, message: string): Promise<void> {
        try {
          await action();
          throw new Error("Expected mutation to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
        expect(await readEvents(storePath)).toHaveLength(originalEvents.length);
      }

      await expectInvalidArgument(() => engine.revise(null as never), "Invalid revise input");
      await expectInvalidArgument(() => engine.revise({
        record_id: "",
        patch: { "content.text": "No-op" },
        source: { client: "test" }
      }), "Invalid record_id");
      await expectInvalidArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: [] as never,
        source: { client: "test" }
      }), "Invalid patch");
      await expectInvalidArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: { "content.text": "No-op" },
        source: { client: "" }
      }), "Invalid source.client");
      await expectInvalidArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: { "content.text": "No-op" },
        reason: "",
        source: { client: "test" }
      }), "Invalid reason");

      await expectInvalidArgument(() => engine.promote(null as never), "Invalid promote input");
      await expectInvalidArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "published" as never,
        source: { client: "test" }
      }), "Invalid target_state");
      await expectInvalidArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "canonical",
        confirmed: "yes" as never,
        source: { client: "test" }
      }), "Invalid confirmed");
      await expectInvalidArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "canonical",
        reason: "",
        source: { client: "test" }
      }), "Invalid reason");

      await expectInvalidArgument(() => engine.archive(null as never), "Invalid archive input");
      await expectInvalidArgument(() => engine.archive({
        record_id: "",
        source: { client: "test" }
      }), "Invalid record_id");
      await expectInvalidArgument(() => engine.archive({
        record_id: existing.record.id,
        reason: "",
        source: { client: "test" }
      }), "Invalid reason");
      await expectInvalidArgument(() => engine.quarantine(null as never), "Invalid quarantine input");
      await expectInvalidArgument(() => engine.quarantine({
        record_id: existing.record.id,
        reason: 123 as never,
        source: { client: "test" }
      }), "Invalid reason");
      await expectInvalidArgument(() => engine.quarantine({
        record_id: existing.record.id,
        reason: "",
        source: { client: "test" }
      }), "Invalid reason");

      await expectInvalidArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: "",
        link_type: "supersedes",
        source: { client: "test" }
      }), "Invalid linked_record_id");
      await expectInvalidArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: linked.record.id,
        link_type: "",
        source: { client: "test" }
      }), "Invalid link_type");
      await expectInvalidArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: linked.record.id,
        link_type: "supersedes",
        source: { client: "" }
      }), "Invalid source.client");
    });
  });
});
