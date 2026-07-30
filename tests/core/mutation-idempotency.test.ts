import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { IdempotencyCollisionError, type PartialMutationCommitError } from "../../src/core/idempotency.js";
import { automationOutcome } from "../../src/core/operation-outcome.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const writeInput = {
  kind: "agent_note" as const,
  type: "automation_test",
  scope: "project" as const,
  project_id: "moryn",
  tags: ["automation"],
  content: { format: "text" as const, text: "Durable automation mutation" },
  source: { client: "test", session_id: "session-a", device_id: "device-a" }
};

describe("mutation idempotency", () => {
  it("does not expose a completed non-idempotent write as safe to retry", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const result = await engine.write(writeInput);

      expect(result).toMatchObject({ committed: true, durability: "best_effort" });
      expect(result.event).not.toHaveProperty("idempotency");
      expect(automationOutcome(result)).toMatchObject({
        status: "completed_with_warnings",
        committed: true,
        retryable: false,
        next_action: {
          recommended_action: "inspect_returned_committed_result_before_new_mutation",
          reason: "mutation_committed_without_idempotency_key",
          inspection_source: "returned_committed_result",
          committed_event_ids: [result.event.event_id],
          retry_original_mutation: false
        }
      });
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("replays the same write receipt without storing the caller key", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const first = await engine.write({ ...writeInput, idempotency_key: "request-42" });
      const replay = await engine.write({ ...writeInput, idempotency_key: "request-42" });
      const events = await readEvents(storePath);

      expect(first).toMatchObject({ committed: true, idempotent_replay: false, durability: "confirmed" });
      expect(replay).toMatchObject({
        committed: true,
        idempotent_replay: true,
        record: { id: first.record.id },
        replayed_event_ids: [first.event.event_id]
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("request-42");
      expect(first.event.idempotency).toMatchObject({ version: 1, operation: "write" });
    });
  });

  it("preserves canonical confirmation guidance on replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const request = {
        ...writeInput,
        type: "security_rule",
        state: "canonical" as const,
        idempotency_key: "canonical-confirmation-replay"
      };

      const first = await engine.write(request);
      const replay = await engine.write(request);

      expect(first).toMatchObject({
        record: { state: "candidate" },
        warning: { code: "CONFIRMATION_REQUIRED", next_action: { tool: "promote" } }
      });
      expect(replay).toMatchObject({
        idempotent_replay: true,
        record: { id: first.record.id, state: "candidate" },
        warning: { code: "CONFIRMATION_REQUIRED", next_action: { tool: "promote" } }
      });
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("serializes concurrent requests with one durable event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, rebuild: async () => undefined });
      const results = await Promise.all([
        engine.write({ ...writeInput, idempotency_key: "concurrent-1" }),
        engine.write({ ...writeInput, idempotency_key: "concurrent-1" })
      ]);

      expect(results.map((result) => result.idempotent_replay).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.record.id))).toHaveProperty("size", 1);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("rejects reuse of one key for a different request", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.write({ ...writeInput, idempotency_key: "collision-1" });

      await expect(
        engine.write({
          ...writeInput,
          content: { format: "text", text: "A different mutation" },
          idempotency_key: "collision-1"
        })
      ).rejects.toBeInstanceOf(IdempotencyCollisionError);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("repairs derived views on replay after the original event was already committed", async () => {
    await withInitializedTempStore(async (storePath) => {
      let rebuilds = 0;
      const engine = createEngine({
        storePath,
        rebuild: async () => {
          rebuilds += 1;
          if (rebuilds === 1) throw new Error("derived view unavailable");
        }
      });
      const first = await engine.write({ ...writeInput, idempotency_key: "rebuild-1" });
      const replay = await engine.write({ ...writeInput, idempotency_key: "rebuild-1" });

      expect(first).toMatchObject({
        committed: true,
        derived_views_refreshed: false,
        warnings: [{ code: "DERIVED_VIEW_REBUILD_FAILED" }]
      });
      expect(replay).toMatchObject({ committed: true, idempotent_replay: true, derived_views_refreshed: true });
      expect(rebuilds).toBe(2);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("supports replay receipts across revise, promote, archive, quarantine, and link", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const source = await engine.write({ ...writeInput, content: { text: "Source record" } });
      const target = await engine.write({
        ...writeInput,
        type: "automation_target",
        content: { text: "Target record" }
      });

      const revise = () =>
        engine.revise({
          record_id: source.record.id,
          patch: { "content.text": "Revised source record" },
          reason: "automation replay",
          idempotency_key: "revise-1"
        });
      const promote = () =>
        engine.promote({
          record_id: source.record.id,
          target_state: "canonical",
          reason: "automation replay",
          confirmed: true,
          idempotency_key: "promote-1"
        });
      const archive = () =>
        engine.archive({ record_id: source.record.id, reason: "automation replay", idempotency_key: "archive-1" });
      const quarantine = () =>
        engine.quarantine({
          record_id: target.record.id,
          reason: "automation replay",
          idempotency_key: "quarantine-1"
        });
      const link = () =>
        engine.link({
          record_id: source.record.id,
          linked_record_id: target.record.id,
          link_type: "supports",
          idempotency_key: "link-1"
        });

      for (const operation of [revise, promote, archive, quarantine, link]) {
        expect((await operation()).idempotent_replay).toBe(false);
        expect((await operation()).idempotent_replay).toBe(true);
      }
      expect(await readEvents(storePath)).toHaveLength(7);
    });
  });

  it("does not mistake a literal redaction token for durable redaction evidence on revise replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const source = await engine.write({ ...writeInput, content: { text: "Original documentation text" } });
      const request = {
        record_id: source.record.id,
        patch: { "content.text": "The literal [REDACTED_SECRET] token is documented here." },
        reason: "document the public redaction token",
        idempotency_key: "literal-redaction-token"
      };

      const first = await engine.revise(request);
      const replay = await engine.revise(request);
      const events = await readEvents(storePath);

      expect(first).toMatchObject({ idempotent_replay: false });
      expect(first.event).not.toHaveProperty("redaction");
      expect(replay).toMatchObject({
        idempotent_replay: true,
        event: { event_id: first.event.event_id }
      });
      expect(replay.event).not.toHaveProperty("redaction");
      expect(events.filter((event) => event.op === "quarantine_record")).toHaveLength(0);
      expect(
        (
          await engine.recall({
            record_ids: [source.record.id],
            states: ["raw"],
            project_id: "moryn"
          })
        ).results[0]?.record
      ).toMatchObject({ state: "raw", content: { text: request.patch["content.text"] } });
    });
  });

  it("recovers a legacy composite-sensitive revision from its event-time record state", async () => {
    await withInitializedTempStore(async (storePath) => {
      let failedQuarantine = false;
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.op === "revise_record" && event.redaction) {
            const legacyRevision = { ...event };
            delete legacyRevision.redaction;
            return appendEventIfAbsent(path, legacyRevision);
          }
          if (event.idempotency?.operation === "revise_quarantine" && !failedQuarantine) {
            failedQuarantine = true;
            throw new Error("injected legacy quarantine append failure");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const source = await engine.write({
        ...writeInput,
        type: "legacy_composite_sensitive_revision",
        content: { text: "ENV_ONE=alpha\nENV_TWO=beta\nENV_THREE=gamma\nENV_FOUR=delta" }
      });
      const request = {
        record_id: source.record.id,
        patch: { "content.extra_env": "ENV_FIVE=epsilon" },
        reason: "complete the environment example",
        idempotency_key: "legacy-composite-sensitive-revise"
      };

      await expect(engine.revise(request)).rejects.toMatchObject({
        code: "MUTATION_PARTIALLY_COMMITTED",
        committed: true
      });
      expect((await readEvents(storePath)).find((event) => event.op === "revise_record")).not.toHaveProperty(
        "redaction"
      );

      await engine.revise({
        record_id: source.record.id,
        patch: { "content.text": "ENV_ONE=alpha\nENV_TWO=beta\nENV_THREE=gamma" },
        reason: "later cleanup after the partial revision"
      });

      const resumed = await engine.revise(request);
      expect(resumed).toMatchObject({
        committed: true,
        warning: { code: "SENSITIVE_CONTENT_DETECTED" },
        quarantine_event: { op: "quarantine_record" }
      });
      const events = await readEvents(storePath);
      expect(events.filter((event) => event.op === "quarantine_record")).toHaveLength(1);
      expect(
        (
          await engine.recall({
            record_ids: [source.record.id],
            states: ["quarantined"],
            project_id: "moryn"
          })
        ).results[0]?.record.state
      ).toBe("quarantined");
    });
  });

  it("replays a successful promotion before re-evaluating later conflicts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const source = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["release-channel"],
        content: { text: "The release channel is blue." },
        state: "candidate",
        source: { client: "user" }
      });
      const request = {
        record_id: source.record.id,
        target_state: "canonical" as const,
        reason: "verified release channel",
        idempotency_key: "promote-before-conflict"
      };
      const first = await engine.promote(request);
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["release-channel"],
        content: { text: "The release channel is green." },
        state: "canonical",
        source: { client: "user" }
      });

      const replay = await engine.promote(request);
      expect(first.idempotent_replay).toBe(false);
      expect(replay).toMatchObject({
        idempotent_replay: true,
        replayed_event_ids: [first.event.event_id]
      });
    });
  });

  it("reports and resumes a partially committed sensitive revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      let failedQuarantine = false;
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.idempotency?.operation === "revise_quarantine" && !failedQuarantine) {
            failedQuarantine = true;
            throw new Error("injected quarantine append failure");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const source = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Review authorization before release." },
        state: "canonical",
        source: { client: "user" }
      });
      const request = {
        record_id: source.record.id,
        patch: { "content.text": "Authorization: Bearer ghp_1234567890abcdef" },
        reason: "pasted request header",
        idempotency_key: "sensitive-revise-retry"
      };

      await expect(engine.revise(request)).rejects.toMatchObject({
        code: "MUTATION_PARTIALLY_COMMITTED",
        committed: true,
        recovery_hint: { committed_event_ids: [expect.any(String)] }
      } satisfies Partial<PartialMutationCommitError>);
      expect((await readEvents(storePath)).find((event) => event.op === "revise_record")).toMatchObject({
        redaction: { kind: "sensitive_content", applied: true }
      });
      const resumed = await engine.revise(request);
      expect(resumed).toMatchObject({
        committed: true,
        replayed_event_ids: [expect.any(String)],
        warning: { code: "SENSITIVE_CONTENT_DETECTED" }
      });
      expect(await readEvents(storePath)).toHaveLength(3);
      expect(
        (
          await engine.recall({
            record_ids: [source.record.id],
            states: ["quarantined"],
            project_id: "moryn"
          })
        ).results[0]?.record.state
      ).toBe("quarantined");
    });
  });

  it("derives a stable recovery identity for sensitive revisions without a caller key", async () => {
    await withInitializedTempStore(async (storePath) => {
      let failedQuarantine = false;
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.idempotency?.operation === "revise_quarantine" && !failedQuarantine) {
            failedQuarantine = true;
            throw new Error("injected quarantine append failure");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const source = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Review authorization before release." },
        state: "canonical",
        source: { client: "user" }
      });
      const request = {
        record_id: source.record.id,
        patch: { "content.text": "Authorization: Bearer ghp_1234567890abcdef" },
        reason: "pasted request header"
      };

      await expect(engine.revise(request)).rejects.toMatchObject({
        code: "MUTATION_PARTIALLY_COMMITTED",
        committed: true,
        recovery_hint: {
          committed_event_ids: [expect.any(String)],
          retry_with: { request: "same mutation arguments", idempotency_key: "leave omitted" }
        }
      });
      const resumed = await engine.revise(request);
      expect(resumed).toMatchObject({
        committed: true,
        replayed_event_ids: [expect.any(String)],
        warning: { code: "SENSITIVE_CONTENT_DETECTED" }
      });
      const events = await readEvents(storePath);
      expect(events).toHaveLength(3);
      expect(JSON.stringify(events)).not.toContain("ghp_1234567890abcdef");
      expect(
        (
          await engine.recall({
            record_ids: [source.record.id],
            states: ["quarantined"],
            project_id: "moryn"
          })
        ).results[0]?.record.state
      ).toBe("quarantined");
    });
  });

  it("keeps ordinary revisions without a caller key as independent events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const source = await engine.write({ ...writeInput, content: { text: "Original text" } });
      const request = {
        record_id: source.record.id,
        patch: { "content.text": "Revised text" },
        reason: "ordinary revision"
      };

      await engine.revise(request);
      await engine.revise(request);

      const revisions = (await readEvents(storePath)).filter((event) => event.op === "revise_record");
      expect(revisions).toHaveLength(2);
      expect(revisions.every((event) => event.idempotency === undefined)).toBe(true);
    });
  });
});
