import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildCheckpointRecoveryPack,
  checkpointIdentity,
  normalizeCheckpointInput,
  recoveryPack
} from "../../src/core/checkpoint.js";
import { createEngine } from "../../src/core/engine.js";
import { pendingLearningInbox, queueLearning } from "../../src/core/learning-inbox.js";
import { learningRecordIdentity } from "../../src/core/learning-ingestion.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import type { MorynRecord } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const baseDelta = {
  session_id: " session-1 ",
  checkpoint_id: " checkpoint-1 ",
  current_task: " Persist checkpoints ",
  progress: [" wrote tests ", "wrote tests", ""],
  decisions: [],
  changed_facts: [],
  blockers: [],
  next_steps: [" implement storage "],
  files: [" src/core/checkpoint.ts "],
  candidate_memories: [],
  candidate_skills: [],
  learnings: []
};
const execFileAsync = promisify(execFile);
const authored = {
  occurred_at: "2026-07-11T00:00:00.000Z",
  source: { client: "codex", session_id: "session-1", device_id: "device-test" }
};

function createTestEngine(storePath: string) {
  let sequence = 0;
  return createEngine({
    storePath,
    now: () => "2026-07-11T00:00:00.000Z",
    id: (prefix) => `${prefix}_${++sequence}`
  });
}

function checkpointRecord(
  overrides: Partial<MorynRecord> & {
    id: string;
    checkpoint_id: string;
    occurred_at: string;
    session_id?: string;
    project_id?: string;
    delta?: Record<string, unknown>;
  }
): MorynRecord {
  const sessionId = overrides.session_id ?? "session-1";
  return {
    ...overrides,
    id: overrides.id,
    kind: "session_summary",
    type: "checkpoint",
    scope: "project",
    project_id: overrides.project_id ?? "project-a",
    tags: overrides.tags ?? ["checkpoint", `session:${sessionId}`],
    content: overrides.content ?? {
      format: "json",
      text: overrides.id,
      checkpoint_version: 1,
      checkpoint: {
        session_id: sessionId,
        checkpoint_id: overrides.checkpoint_id,
        progress: [overrides.id],
        decisions: [],
        changed_facts: [],
        blockers: [],
        next_steps: [],
        files: [],
        candidate_memories: [],
        candidate_skills: [],
        learnings: [],
        ...overrides.delta
      }
    },
    state: "candidate",
    confidence: 0.5,
    priority: "normal",
    visibility: overrides.visibility ?? "active",
    created_at: overrides.occurred_at,
    updated_at: overrides.updated_at ?? overrides.occurred_at,
    source: overrides.source ?? { client: "codex", session_id: sessionId },
    provenance: { method: "agent-proposed" }
  } as MorynRecord;
}

describe("buildCheckpointRecoveryPack", () => {
  it("aggregates the latest five valid checkpoints in chronological order with bounded exact dedup", () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      checkpointRecord({
        id: `record-${index + 1}`,
        checkpoint_id: `checkpoint-${index + 1}`,
        occurred_at: `2026-07-11T00:0${index}:00.000Z`,
        delta: {
          current_task: index === 5 ? "older task" : index === 6 ? "latest task" : undefined,
          progress: [`progress-${index + 1}`, "shared"],
          decisions: Array.from({ length: 3 }, (__, item) => `decision-${index}-${item}`),
          blockers: index === 5 ? ["resolved blocker"] : index === 6 ? [] : ["old blocker"],
          next_steps: index === 6 ? ["ship it"] : ["obsolete step"]
        }
      })
    );

    const pack = buildCheckpointRecoveryPack(records, { project_id: "project-a", session_id: "session-1" });

    expect(pack).toMatchObject({
      version: 1,
      available: true,
      bounded: true,
      project_id: "project-a",
      session_id: "session-1",
      latest_checkpoint_id: "checkpoint-7",
      latest_occurred_at: "2026-07-11T00:06:00.000Z",
      source_record_ids: ["record-3", "record-4", "record-5", "record-6", "record-7"],
      checkpoint_count: 5,
      current_task: "latest task",
      blockers: [],
      next_steps: ["ship it"]
    });
    expect(pack.progress).toEqual(["progress-3", "shared", "progress-4", "progress-5", "progress-6", "progress-7"]);
    expect(pack.decisions).toHaveLength(10);
  });

  it("filters invalid records and deterministically orders timestamp ties by updated_at then record id", () => {
    const validA = checkpointRecord({
      id: "b",
      checkpoint_id: "b",
      occurred_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:01:00.000Z"
    });
    const validB = checkpointRecord({
      id: "a",
      checkpoint_id: "a",
      occurred_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:01:00.000Z"
    });
    const excluded = [
      checkpointRecord({
        id: "other-session",
        checkpoint_id: "x",
        occurred_at: "2026-07-11T00:02:00.000Z",
        session_id: "other"
      }),
      checkpointRecord({
        id: "other-project",
        checkpoint_id: "x",
        occurred_at: "2026-07-11T00:02:00.000Z",
        project_id: "other"
      }),
      checkpointRecord({
        id: "archived",
        checkpoint_id: "x",
        occurred_at: "2026-07-11T00:02:00.000Z",
        visibility: "archived"
      }),
      checkpointRecord({
        id: "quarantined",
        checkpoint_id: "x",
        occurred_at: "2026-07-11T00:02:00.000Z",
        visibility: "quarantined"
      }),
      checkpointRecord({
        id: "malformed",
        checkpoint_id: "x",
        occurred_at: "2026-07-11T00:02:00.000Z",
        content: { format: "json", text: "bad", checkpoint_version: 1, checkpoint: { nope: true } }
      })
    ];

    expect(
      buildCheckpointRecoveryPack([validA, ...excluded, validB], { project_id: "project-a", session_id: "session-1" })
        .source_record_ids
    ).toEqual(["a", "b"]);
  });

  it("enforces private boundaries without leaking ids or counts and preserves canonical learning dedup", () => {
    const learning = {
      question: "Q",
      conclusion: "A",
      evidence_type: "source_code",
      scope: "project",
      confidence: 0.8,
      recommended_kind: "memory",
      recommended_type: "fact",
      related_record_ids: ["b", "a"]
    };
    const publicRecord = checkpointRecord({
      id: "public",
      checkpoint_id: "public",
      occurred_at: "2026-07-11T00:00:00.000Z",
      delta: { progress: ["public progress"], learnings: [learning] }
    });
    const privateRecord = checkpointRecord({
      id: "private",
      checkpoint_id: "private",
      occurred_at: "2026-07-11T00:01:00.000Z",
      tags: ["private"],
      delta: { progress: ["secret progress"], learnings: [{ ...learning, related_record_ids: ["a", "b"] }] }
    });

    const mixed = buildCheckpointRecoveryPack([privateRecord, publicRecord], {
      project_id: "project-a",
      session_id: "session-1"
    });
    expect(mixed.source_record_ids).toEqual(["public"]);
    expect(mixed.checkpoint_count).toBe(1);
    expect(mixed.progress).toEqual(["public progress"]);
    expect(mixed.learnings).toHaveLength(1);
    const hidden = buildCheckpointRecoveryPack([privateRecord], { project_id: "project-a", session_id: "session-1" });
    expect(hidden).toMatchObject({ available: false, checkpoint_count: 0, source_record_ids: [] });
    expect(hidden).not.toHaveProperty("progress");
    expect(hidden).not.toHaveProperty("latest_checkpoint_id");
    expect(hidden).not.toHaveProperty("latest_occurred_at");
    const included = buildCheckpointRecoveryPack([privateRecord, publicRecord], {
      project_id: "project-a",
      session_id: "session-1",
      include_private: true
    });
    expect(included.progress).toEqual(["public progress", "secret progress"]);
    expect(included.source_record_ids).toEqual(["public", "private"]);
    expect(included.checkpoint_count).toBe(2);
    expect(included.learnings).toHaveLength(1);
  });

  it.each([
    ["content privacy", { privacy: "private" }],
    ["local-only distribution", { distribution: "local_only" }]
  ] as const)("keeps checkpoints with %s behind include_private", (_label, privacyMarker) => {
    const privateRecord = checkpointRecord({
      id: "legacy-private",
      checkpoint_id: "legacy-private",
      occurred_at: "2026-07-11T00:01:00.000Z",
      delta: { progress: ["private progress"] }
    });
    privateRecord.content = { ...privateRecord.content, ...privacyMarker };

    const hidden = buildCheckpointRecoveryPack([privateRecord], {
      project_id: "project-a",
      session_id: "session-1"
    });
    const included = buildCheckpointRecoveryPack([privateRecord], {
      project_id: "project-a",
      session_id: "session-1",
      include_private: true
    });

    expect(hidden).toMatchObject({ available: false, checkpoint_count: 0, source_record_ids: [] });
    expect(included).toMatchObject({
      available: true,
      checkpoint_count: 1,
      source_record_ids: [privateRecord.id],
      progress: ["private progress"]
    });
  });

  it("selects the latest five visible checkpoints before private records can consume the limit", () => {
    const publicRecord = checkpointRecord({
      id: "public",
      checkpoint_id: "public",
      occurred_at: "2026-07-11T00:00:00.000Z",
      delta: { progress: ["public progress"] }
    });
    const privateRecords = Array.from({ length: 6 }, (_, index) =>
      checkpointRecord({
        id: `private-${index + 1}`,
        checkpoint_id: `private-${index + 1}`,
        occurred_at: `2026-07-11T00:0${index + 1}:00.000Z`,
        tags: [index % 3 === 0 ? "private" : index % 3 === 1 ? "secret" : "sensitive"],
        delta: { progress: [`secret-${index + 1}`] }
      })
    );

    const hidden = buildCheckpointRecoveryPack([publicRecord, ...privateRecords], {
      project_id: "project-a",
      session_id: "session-1"
    });
    expect(hidden).toMatchObject({
      available: true,
      checkpoint_count: 1,
      source_record_ids: ["public"],
      latest_checkpoint_id: "public",
      progress: ["public progress"]
    });
    const included = buildCheckpointRecoveryPack([publicRecord, ...privateRecords], {
      project_id: "project-a",
      session_id: "session-1",
      include_private: true
    });
    expect(included.source_record_ids).toEqual(["private-2", "private-3", "private-4", "private-5", "private-6"]);
    expect(included.checkpoint_count).toBe(5);
  });

  it("prioritizes newest unique values within caps while displaying selected values chronologically", () => {
    const learning = (value: number) => ({
      question: `Q${value}`,
      conclusion: `A${value}`,
      evidence_type: "source_code" as const,
      scope: "project" as const,
      confidence: 0.8,
      recommended_kind: "memory" as const,
      recommended_type: "fact",
      related_record_ids: []
    });
    const older = checkpointRecord({
      id: "older",
      checkpoint_id: "older",
      occurred_at: "2026-07-11T00:00:00.000Z",
      delta: {
        progress: Array.from({ length: 10 }, (_, index) => `old-${index}`),
        learnings: Array.from({ length: 10 }, (_, index) => learning(index))
      }
    });
    const latest = checkpointRecord({
      id: "latest",
      checkpoint_id: "latest",
      occurred_at: "2026-07-11T00:01:00.000Z",
      delta: { progress: ["latest-a", "old-9", "latest-b"], learnings: [learning(10), learning(9), learning(11)] }
    });

    const pack = buildCheckpointRecoveryPack([latest, older], { project_id: "project-a", session_id: "session-1" });

    expect(pack.progress).toEqual([
      "old-0",
      "old-1",
      "old-2",
      "old-3",
      "old-4",
      "old-5",
      "old-6",
      "old-9",
      "latest-a",
      "latest-b"
    ]);
    expect(pack.progress).toHaveLength(10);
    expect(pack.learnings?.map((item) => item.question)).toEqual([
      "Q0",
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6",
      "Q9",
      "Q10",
      "Q11"
    ]);
  });

  it("recovers the latest compact-safe knowledge investigation state", () => {
    const older = checkpointRecord({
      id: "older-investigation",
      checkpoint_id: "older-investigation",
      occurred_at: "2026-07-11T00:00:00.000Z",
      delta: {
        knowledge_investigations: [
          {
            resolution_id: "rollback",
            question: "What is rollback policy?",
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [],
            status: "unresolved",
            next_step: "Inspect release code"
          }
        ]
      }
    });
    const latest = checkpointRecord({
      id: "latest-investigation",
      checkpoint_id: "latest-investigation",
      occurred_at: "2026-07-11T00:01:00.000Z",
      delta: {
        knowledge_investigations: [
          {
            resolution_id: "rollback",
            question: "What is rollback policy?",
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [{ type: "source_code", reference: "src/release.ts", summary: "Signed tags are validated" }],
            status: "unresolved",
            next_step: "Run rollback integration test"
          },
          {
            resolution_id: "retention",
            question: "How long are artifacts retained?",
            recall_status: "verification_required",
            recalled_record_ids: ["rec-retention"],
            evidence: [{ type: "documentation", reference: "docs/release.md", summary: "Thirty days" }],
            status: "resolved",
            conclusion: "Artifacts are retained for thirty days"
          }
        ]
      }
    });

    const pack = buildCheckpointRecoveryPack([older, latest], { project_id: "project-a", session_id: "session-1" });

    expect(pack.knowledge_investigations).toEqual([
      expect.objectContaining({
        resolution_id: "rollback",
        status: "unresolved",
        next_step: "Run rollback integration test",
        evidence: [expect.objectContaining({ reference: "src/release.ts" })]
      }),
      expect.objectContaining({
        resolution_id: "retention",
        status: "resolved",
        conclusion: "Artifacts are retained for thirty days"
      })
    ]);
  });

  it.each([0, -1, 1.5, 6, Number.NaN])("rejects invalid checkpoint recovery limit %s", (limit) => {
    expect(() => buildCheckpointRecoveryPack([], { project_id: "project-a", session_id: "session-1", limit })).toThrow(
      "Invalid argument: limit must be an integer between 1 and 5"
    );
  });
});

describe("engine.checkpoint", () => {
  it("automatically links public project exact duplicates without touching private or operational records", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const durable = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "project-a",
        tags: ["lifecycle"],
        content: { text: "Checkpoint events are append-only." }
      } as const;
      const canonical = await engine.write({
        ...durable,
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const duplicate = await engine.write({ ...durable, source: { client: "codex" } });
      const privateFact = {
        ...durable,
        tags: ["private"],
        content: { text: "Private checkpoint preference." }
      } as const;
      const privateRecords = [
        await engine.write({ ...privateFact, source: { client: "codex" } }),
        await engine.write({ ...privateFact, source: { client: "claude-code" } })
      ];
      const globalFact = {
        ...durable,
        scope: "global",
        tags: ["global"],
        content: { text: "Global exact duplicates are outside project lifecycle maintenance." }
      } as const;
      const globalRecords = [
        await engine.write({ ...globalFact, source: { client: "codex" } }),
        await engine.write({ ...globalFact, source: { client: "claude-code" } })
      ];
      const operational = {
        kind: "session_summary",
        type: "handoff",
        scope: "project",
        project_id: "project-a",
        tags: ["handoff"],
        content: { text: "Same operational receipt." }
      } as const;
      const operationalRecords = [
        await engine.write({ ...operational, source: { client: "codex" } }),
        await engine.write({ ...operational, source: { client: "claude-code" } })
      ];
      const conflictedFact = {
        ...durable,
        tags: ["conflicted"],
        content: { text: "A conflict marker keeps exact facts visible for review." }
      } as const;
      const conflictedRecords = [
        await engine.write({ ...conflictedFact, source: { client: "codex" } }),
        await engine.write({ ...conflictedFact, source: { client: "claude-code" } })
      ];
      await engine.logicalLink({
        record_id: conflictedRecords[0].record.id,
        linked_record_id: conflictedRecords[1].record.id,
        relationship: "conflicts_with",
        reason: "Keep explicit review state",
        source: { client: "codex" }
      });
      const input = {
        project_id: "project-a",
        ...authored,
        delta: { ...baseDelta, checkpoint_id: "automatic-exact-dedup" }
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first.exact_duplicate_consolidation).toMatchObject({
        status: "completed",
        project_id: "project-a",
        privacy_boundary: "public",
        record_kinds: ["memory", "skill", "soul"],
        groups_found: 1,
        links_created: 1,
        groups: [
          {
            target_record_id: canonical.record.id,
            duplicate_record_ids: [duplicate.record.id]
          }
        ]
      });
      expect(replay.exact_duplicate_consolidation).toMatchObject({
        status: "completed",
        groups_found: 0,
        links_created: 0
      });
      const events = await readEvents(storePath);
      const exactLinks = events.filter(
        (event) => event.op === "link_records" && event.event_id.startsWith("evt_duplicate_")
      );
      expect(exactLinks).toHaveLength(1);
      expect(
        exactLinks.some(
          (event) =>
            event.op === "link_records" &&
            conflictedRecords.some(
              (record) => event.record_id === record.record.id || event.linked_record_id === record.record.id
            )
        )
      ).toBe(false);
      expect(events.some((event) => event.op === "archive_record")).toBe(false);
      const records = (await engine.listRecent({ limit: 100, include_private: true })).records;
      const duplicateAudit = await engine.recall({
        record_ids: [duplicate.record.id],
        include_private: true
      });
      for (const record of [...privateRecords, ...globalRecords, ...operationalRecords].map(
        (result) => result.record
      )) {
        expect(records.find((candidate) => candidate.id === record.id)?.links).toBeUndefined();
      }
      expect(records.map((record) => record.id)).toContain(canonical.record.id);
      expect(records.map((record) => record.id)).not.toContain(duplicate.record.id);
      expect(duplicateAudit.results[0]?.record.links).toContainEqual(
        expect.objectContaining({
          record_id: canonical.record.id,
          link_type: "duplicate_of"
        })
      );
    });
  });

  it("keeps a checkpoint durable when automatic exact duplicate maintenance fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const writer = createTestEngine(storePath);
      const duplicate = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "project-a",
        tags: ["durability"],
        content: { text: "Exact duplicate maintenance is best effort." },
        source: { client: "codex" }
      } as const;
      await writer.write(duplicate);
      await writer.write(duplicate);
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_duplicate_")) throw new Error("exact duplicate disk failure");
          return appendEventIfAbsent(path, event);
        }
      });

      const result = await engine.checkpoint({
        project_id: "project-a",
        ...authored,
        delta: { ...baseDelta, checkpoint_id: "automatic-exact-dedup-failure" }
      });

      expect(result).toMatchObject({
        committed: true,
        exact_duplicate_consolidation: {
          status: "failed",
          project_id: "project-a",
          privacy_boundary: "public",
          reason: "exact duplicate disk failure"
        }
      });
      expect(await engine.recall({ record_ids: [result.record.id], project_id: "project-a" })).toMatchObject({
        results: [{ record: { id: result.record.id } }]
      });
    });
  });

  it("keeps a checkpoint durable when the automatic event audit fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        runAutomaticEventAudit: async () => ({
          status: "failed",
          failure_stage: "replay",
          code: "EVENT_REPLAY_INVALID",
          reason: "Stored event history could not be replayed safely.",
          event_count: 1,
          record_count: 0,
          snapshot_status: "not_checked"
        })
      });

      const result = await engine.checkpoint({
        project_id: "project-a",
        ...authored,
        delta: { ...baseDelta, checkpoint_id: "automatic-event-audit-failure" }
      });

      expect(result).toMatchObject({
        committed: true,
        automatic_event_audit: {
          status: "failed",
          failure_stage: "replay",
          code: "EVENT_REPLAY_INVALID",
          snapshot_status: "not_checked"
        },
        selection_sources: { automatic_event_audit: "automatic_event_audit" }
      });
      expect(await engine.recall({ record_ids: [result.record.id], project_id: "project-a" })).toMatchObject({
        results: [{ record: { id: result.record.id } }]
      });
    });
  });

  it("automatically consumes queued learning and preserves idempotent replay evidence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const queued = await queueLearning(storePath, {
        project_id: "project-a",
        question: "What protects a learning before compact?",
        conclusion: "Learning Inbox persists supported conclusions before compact.",
        evidence_type: "source_code",
        source: authored.source,
        occurred_at: "2026-07-10T23:59:00.000Z"
      });
      const input = {
        project_id: "project-a",
        ...authored,
        delta: { ...baseDelta, checkpoint_id: "learning-inbox", learnings: [] }
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first).toMatchObject({
        learning_ingestion: { learnings_received: 1, records_created: 1 },
        learning_inbox: { selected: 1, consumed: 1, already_consumed: 0, inbox_record_ids: [queued.record.id] }
      });
      expect(replay).toMatchObject({
        idempotent_replay: true,
        learning_ingestion: { learnings_received: 1, records_created: 0 },
        learning_inbox: { selected: 1, consumed: 0, already_consumed: 1, inbox_record_ids: [queued.record.id] }
      });
      expect(await pendingLearningInbox(storePath, { project_id: "project-a" })).toHaveLength(0);
      const [consumed] = await pendingLearningInbox(storePath, { project_id: "project-a", include_consumed: true });
      expect(consumed).toMatchObject({
        content: {
          status: "consumed",
          consumed_by_record_id: first.record.id,
          produced_record_ids: first.learning_ingestion.dispositions.map((item) => item.record_id)
        }
      });
    });
  });

  it("consolidates authored proposals after durable learning ingestion", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "project-a",
        content: { text: "Moryn pulls on agent enter." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "When does Moryn pull?",
        conclusion: "Moryn pulls when an agent enters.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "project-a", learning }).record_id;
      const input = {
        project_id: "project-a",
        ...authored,
        delta: {
          ...baseDelta,
          checkpoint_id: "semantic-consolidation",
          learnings: [learning],
          semantic_consolidation_proposals: [
            {
              proposal_id: "proposal-1",
              source_record_id: sourceRecordId,
              target_record_id: target.record.id,
              relationship: "duplicate_of" as const,
              confidence: 0.99,
              rationale: "Equivalent lifecycle fact.",
              semantic_equivalence: "equivalent" as const,
              material_differences: [],
              evidence_record_ids: []
            }
          ]
        }
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first.committed).toBe(true);
      expect(first.learning_ingestion).toMatchObject({
        records_created: 1,
        dispositions: [{ record_id: sourceRecordId }]
      });
      expect(first.semantic_consolidation).toMatchObject({
        proposals_received: 1,
        links_created: 1,
        proposals_accepted: 1
      });
      expect(replay.semantic_consolidation).toMatchObject({
        proposals_received: 1,
        links_created: 0,
        idempotent_replays: 1
      });
      const events = await readEvents(storePath);
      expect(
        events.findIndex((event) => event.op === "upsert_record" && event.record.id === sourceRecordId)
      ).toBeLessThan(events.findIndex((event) => event.op === "link_records" && event.link_type === "duplicate_of"));
    });
  });

  it("keeps checkpoint durable when semantic consolidation persistence fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const targetWriter = createTestEngine(storePath);
      const target = await targetWriter.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "project-a",
        content: { text: "Moryn pulls on agent enter." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "When does Moryn pull?",
        conclusion: "Moryn pulls when an agent enters.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "project-a", learning }).record_id;
      const engine = createEngine({
        storePath,
        id: (prefix) => `${prefix}_semantic_failure`,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_semantic_consolidation_")) throw new Error("semantic disk failure");
          return appendEventIfAbsent(path, event);
        }
      });
      const result = await engine.checkpoint({
        project_id: "project-a",
        ...authored,
        delta: {
          ...baseDelta,
          checkpoint_id: "semantic-failure",
          learnings: [learning],
          semantic_consolidation_proposals: [
            {
              proposal_id: "proposal-failure",
              source_record_id: sourceRecordId,
              target_record_id: target.record.id,
              relationship: "duplicate_of",
              confidence: 0.99,
              rationale: "Equivalent lifecycle fact.",
              semantic_equivalence: "equivalent",
              material_differences: [],
              evidence_record_ids: []
            }
          ]
        }
      });

      expect(result).toMatchObject({
        committed: true,
        recovery_pack: { available: true },
        semantic_consolidation: {
          proposals_received: 1,
          proposals_rejected: 1,
          rejected_by_reason: { persistence_failed: 1 }
        }
      });
      expect(await engine.recall({ record_ids: [result.record.id], project_id: "project-a" })).toMatchObject({
        results: [{ record: { id: result.record.id } }]
      });
    });
  });

  it("preserves semantic consolidation proposals in checkpoint recovery", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const proposal = {
        proposal_id: "proposal-1",
        source_record_id: "rec-new",
        target_record_id: "rec-old",
        relationship: "duplicate_of" as const,
        confidence: 0.99,
        rationale: "Equivalent lifecycle rule.",
        semantic_equivalence: "equivalent" as const,
        material_differences: [],
        evidence_record_ids: ["rec-evidence"]
      };
      const result = await engine.checkpoint({
        project_id: "project-a",
        ...authored,
        delta: {
          session_id: "session-1",
          checkpoint_id: "semantic-proposal",
          semantic_consolidation_proposals: [proposal]
        }
      });

      expect(result.record.content.checkpoint).toMatchObject({ semantic_consolidation_proposals: [proposal] });
      expect(result.recovery_pack.semantic_consolidation_proposals).toEqual([proposal]);
      expect(
        (await engine.boot({ project_id: "project-a", agent_session_id: "session-1" })).checkpoint_recovery_pack
      ).toMatchObject({
        semantic_consolidation_proposals: [proposal]
      });
    });
  });

  it("materializes checkpoint learnings idempotently before compaction", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const existing = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "project-a",
        content: { text: "Moryn pulls project context on agent enter before work begins." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const input = {
        project_id: "project-a",
        ...authored,
        delta: {
          ...baseDelta,
          learnings: [
            {
              question: "When does Moryn pull?",
              conclusion: "Moryn pulls on agent enter.",
              evidence_type: "source_code" as const,
              scope: "project" as const,
              confidence: 0.9,
              recommended_kind: "memory" as const,
              recommended_type: "fact",
              related_record_ids: []
            }
          ]
        }
      };
      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);
      expect(first.learning_ingestion).toMatchObject({
        learnings_received: 1,
        records_created: 1,
        dispositions: [{ state: "canonical", created: true }],
        semantic_candidates: {
          candidates: [expect.objectContaining({ record_id: existing.record.id })],
          next_action: { action: "recall_then_propose_semantic_relationship" }
        },
        candidate_review: {
          action: "review_learning_candidates",
          owner: "agent",
          candidate_pairs: [
            {
              source_record_id: expect.any(String),
              candidate_record_id: existing.record.id,
              source_recall: {
                tool: "recall",
                arguments: { project_id: "project-a", record_ids: [expect.any(String)] }
              },
              candidate_recall: {
                tool: "recall",
                arguments: { project_id: "project-a", record_ids: [existing.record.id] }
              }
            }
          ]
        }
      });
      expect(replay.learning_ingestion).toMatchObject({
        learnings_received: 1,
        records_created: 0,
        dispositions: [{ state: "canonical", created: false }]
      });
      expect(await readEvents(storePath)).toHaveLength(4);
      const recall = await engine.recall({ project_id: "project-a", query: "Moryn pulls on agent enter." });
      expect(recall.outcome).toMatchObject({ status: "trusted_match" });
    });
  });

  it("persists one normalized checkpoint event and replays idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: " project-a ",
        source: { client: " codex ", session_id: "session-1", model: "gpt", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta,
        tags: [" custom ", "custom", "checkpoint", "session:session-1"]
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first.idempotent_replay).toBe(false);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.record).toEqual(first.record);
      expect(await readEvents(storePath)).toHaveLength(1);
      expect(first.record).toMatchObject({
        kind: "session_summary",
        type: "checkpoint",
        scope: "project",
        project_id: "project-a",
        state: "candidate",
        confidence: 0.5,
        priority: "normal",
        visibility: "active",
        source: { client: "codex", session_id: "session-1", model: "gpt" },
        provenance: { method: "agent-proposed" },
        content: {
          format: "json",
          checkpoint: {
            session_id: "session-1",
            checkpoint_id: "checkpoint-1",
            current_task: "Persist checkpoints",
            progress: ["wrote tests"]
          }
        }
      });
      expect(first.record.content.text).toContain("Persist checkpoints");
      expect(first.record.tags).toEqual(["checkpoint", "checkpoint:checkpoint-1", "custom", "session:session-1"]);
      expect(first.recovery_pack).toMatchObject({
        version: 1,
        available: true,
        bounded: true,
        project_id: "project-a",
        session_id: "session-1",
        latest_checkpoint_id: "checkpoint-1",
        latest_occurred_at: authored.occurred_at,
        source_record_ids: [first.record.id],
        checkpoint_count: 1,
        current_task: "Persist checkpoints",
        progress: ["wrote tests"]
      });
    });
  });

  it("canonicalizes tag order and duplicates for replay and deterministic bytes", async () => {
    const outputs: string[] = [];
    const tagVariants = [
      [" zeta ", "alpha", "alpha", ""],
      ["alpha", "zeta"]
    ];
    for (const tags of tagVariants) {
      await withInitializedTempStore(async (storePath) => {
        const engine = createTestEngine(storePath);
        const input = { project_id: "project-a", ...authored, delta: baseDelta, tags };
        const first = await engine.checkpoint(input);
        const replay = await engine.checkpoint({ ...input, tags: [...tags].reverse() });
        const identity = checkpointIdentity(normalizeCheckpointInput(input));
        outputs.push(await readFile(join(storePath, "events", "idempotent", `${identity.event_id}.json`), "utf8"));

        expect(first.record.tags).toEqual([
          "alpha",
          "checkpoint",
          "checkpoint:checkpoint-1",
          "session:session-1",
          "zeta"
        ]);
        expect(replay.idempotent_replay).toBe(true);
      });
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it("uses code-unit ordering for non-ASCII tags and canonical learning objects", async () => {
    const tags = ["é", "z", "ä", "A"];
    const delta = {
      ...baseDelta,
      learnings: [
        {
          question: "问题",
          conclusion: "结论",
          evidence_type: "source_code" as const,
          scope: "project" as const,
          confidence: 0.8,
          recommended_kind: "memory" as const,
          recommended_type: "事实"
        }
      ]
    };
    const outputs: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await withInitializedTempStore(async (storePath) => {
        const input = { project_id: "project-a", ...authored, delta, tags: index ? [...tags].reverse() : tags };
        const engine = createTestEngine(storePath);
        const result = await engine.checkpoint(input);
        const identity = checkpointIdentity(normalizeCheckpointInput(input));
        outputs.push(await readFile(join(storePath, "events", "idempotent", `${identity.event_id}.json`), "utf8"));

        expect(result.record.tags).toEqual([
          "A",
          "checkpoint",
          "checkpoint:checkpoint-1",
          "session:session-1",
          "z",
          "ä",
          "é"
        ]);
      });
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it("does not confuse distinct idempotency keys", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const variants = [
        {
          project_id: "project-a",
          source: { client: "codex", session_id: "session-1", device_id: "device-test" },
          occurred_at: "2026-07-11T00:00:00.000Z",
          delta: baseDelta
        },
        {
          project_id: "project-b",
          source: { client: "codex", session_id: "session-1", device_id: "device-test" },
          occurred_at: "2026-07-11T00:00:00.000Z",
          delta: baseDelta
        },
        {
          project_id: "project-a",
          source: { client: "claude", session_id: "session-1", device_id: "device-test" },
          occurred_at: authored.occurred_at,
          delta: baseDelta
        },
        {
          project_id: "project-a",
          source: { client: "codex", session_id: "session-2", device_id: "device-test" },
          occurred_at: authored.occurred_at,
          delta: { ...baseDelta, session_id: "session-2" }
        },
        {
          project_id: "project-a",
          source: { client: "codex", session_id: "session-1", device_id: "device-test" },
          occurred_at: "2026-07-11T00:00:00.000Z",
          delta: { ...baseDelta, checkpoint_id: "checkpoint-2" }
        }
      ];

      const results = [];
      for (const variant of variants) results.push(await engine.checkpoint(variant));

      expect(new Set(results.map((result) => result.record.id)).size).toBe(5);
      expect(results.every((result) => result.idempotent_replay === false)).toBe(true);
      expect(await readEvents(storePath)).toHaveLength(5);
    });
  });

  it("rejects invalid project and source identity", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);

      await expect(
        engine.checkpoint({
          project_id: " ",
          source: { client: "codex", session_id: "session-1", device_id: "device-test" },
          occurred_at: "2026-07-11T00:00:00.000Z",
          delta: baseDelta
        })
      ).rejects.toThrow();
      await expect(
        engine.checkpoint({
          project_id: "project-a",
          source: { client: " ", session_id: "session-1", device_id: "device-test" },
          occurred_at: authored.occurred_at,
          delta: baseDelta
        })
      ).rejects.toThrow();
      await expect(
        engine.checkpoint({
          project_id: "project-a",
          source: { client: "codex", session_id: " ", device_id: "device-test" },
          occurred_at: authored.occurred_at,
          delta: baseDelta
        })
      ).rejects.toThrow();
      await expect(
        engine.checkpoint({
          project_id: "project-a",
          source: { client: "codex", session_id: "other", device_id: "device-test" },
          occurred_at: authored.occurred_at,
          delta: baseDelta
        })
      ).rejects.toThrow(/session_id/i);
      await expect(
        engine.checkpoint({
          project_id: "project-a",
          source: { client: "codex", session_id: "session-1", device_id: "" },
          occurred_at: authored.occurred_at,
          delta: baseDelta
        })
      ).rejects.toThrow(/device_id/i);
      await expect(
        engine.checkpoint({
          project_id: "project-a",
          source: authored.source,
          occurred_at: "2026-07-11",
          delta: baseDelta
        })
      ).rejects.toThrow(/occurred_at/i);
      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("finds private checkpoints idempotently but hides recovery content by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        ...authored,
        delta: baseDelta,
        tags: ["private"]
      };

      const _first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);
      const included = await engine.checkpoint({ ...input, include_private: true });

      expect(replay.idempotent_replay).toBe(true);
      expect(replay.recovery_pack).toMatchObject({
        available: false,
        bounded: true,
        source_record_ids: [],
        checkpoint_count: 0
      });
      expect(replay.recovery_pack).not.toHaveProperty("checkpoint");
      expect(included.idempotent_replay).toBe(true);
      expect(included.recovery_pack).toMatchObject({
        available: true,
        current_task: "Persist checkpoints",
        progress: ["wrote tests"]
      });
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("serializes concurrent duplicate calls into one event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };

      const [first, second] = await Promise.all([engine.checkpoint(input), engine.checkpoint(input)]);

      expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
      expect(first.record.id).toBe(second.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("serializes duplicate calls across engine instances", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstEngine = createTestEngine(storePath);
      const secondEngine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };

      const [first, second] = await Promise.all([firstEngine.checkpoint(input), secondEngine.checkpoint(input)]);

      expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
      expect(first.record.id).toBe(second.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("uses deterministic event and record ids for the same authored input", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstEngine = createEngine({ storePath, now: () => "2026-07-11T00:00:00.000Z", id: () => "random_a" });
      const secondEngine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z", id: () => "random_b" });
      const firstInput = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-a" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };
      const secondInput = { ...firstInput };

      const [first, second] = await Promise.all([
        firstEngine.checkpoint(firstInput),
        secondEngine.checkpoint(secondInput)
      ]);

      expect(first.record.id).toBe(second.record.id);
      expect(first.record.id).toMatch(/^rec_checkpoint_[a-f0-9]{64}$/);
      const [event] = await readEvents(storePath);
      expect(event?.event_id).toMatch(/^evt_checkpoint_[a-f0-9]{64}$/);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each([
    { field: "progress", delta: { ...baseDelta, progress: ["different progress"] } },
    { field: "current_task", delta: { ...baseDelta, current_task: "Different task" } },
    {
      field: "learnings",
      delta: {
        ...baseDelta,
        learnings: [
          {
            question: "Q",
            conclusion: "C",
            evidence_type: "source_code",
            scope: "project",
            confidence: 0.8,
            recommended_kind: "memory",
            recommended_type: "fact"
          }
        ]
      }
    }
  ])("rejects same-key payload collision for $field", async ({ delta }) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };
      await engine.checkpoint(input);

      await expect(engine.checkpoint({ ...input, delta })).rejects.toThrow("Checkpoint idempotency collision");
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each([
    { field: "occurred_at", change: { occurred_at: "2026-07-11T00:00:01.000Z" } },
    { field: "device_id", change: { source: { ...authored.source, device_id: "different-device" } } }
  ])("rejects same-key authored payload collision for $field", async ({ change }) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", ...authored, delta: baseDelta };
      await engine.checkpoint(input);

      await expect(engine.checkpoint({ ...input, ...change })).rejects.toThrow("Checkpoint idempotency collision");
    });
  });

  it("writes byte-identical events for identical authored input in independent stores", async () => {
    const outputs: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await withInitializedTempStore(async (storePath) => {
        const engine = createEngine({
          storePath,
          now: () => (index ? "2030-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z")
        });
        const input = {
          project_id: "project-a",
          source: { client: "codex", session_id: "session-1", device_id: "authored-device" },
          occurred_at: "2026-07-11T00:00:00.000Z",
          delta: baseDelta
        };
        const result = await engine.checkpoint(input);
        const identity = checkpointIdentity(normalizeCheckpointInput(input));
        outputs.push(await readFile(join(storePath, "events", "idempotent", `${identity.event_id}.json`), "utf8"));
        expect(result.record.created_at).toBe(input.occurred_at);
      });
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it("rejects deterministic event collisions with mismatched checkpoint content", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };
      const normalized = normalizeCheckpointInput(input);
      const identity = checkpointIdentity(normalized);
      await appendEventIfAbsent(storePath, {
        event_id: identity.event_id,
        op: "upsert_record",
        created_at: "2026-07-10T00:00:00.000Z",
        source: normalized.source,
        record: {
          id: identity.record_id,
          kind: "session_summary",
          type: "checkpoint",
          scope: "project",
          project_id: "other-project",
          tags: ["checkpoint", "session:session-1", "checkpoint:checkpoint-1"],
          content: { format: "json", text: "collision", checkpoint_version: 1, checkpoint: normalized.delta },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-07-10T00:00:00.000Z",
          updated_at: "2026-07-10T00:00:00.000Z",
          source: normalized.source,
          provenance: { method: "agent-proposed" }
        }
      });

      await expect(engine.checkpoint(input)).rejects.toThrow(/idempotency collision/i);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("deduplicates checkpoint creation across child processes", async () => {
    await withInitializedTempStore(async (storePath) => {
      const script = `
        import { createEngine } from './src/core/engine.ts';
        const [storePath, deviceId] = process.argv.slice(1);
        const engine = createEngine({ storePath, now: () => '2026-07-11T00:00:00.000Z' });
        const result = await engine.checkpoint({
          project_id: 'project-a',
          source: { client: 'codex', session_id: 'session-1', device_id: deviceId },
          occurred_at: '2026-07-11T00:00:00.000Z',
          delta: ${JSON.stringify(baseDelta)}
        });
        process.stdout.write(JSON.stringify({ id: result.record.id, replay: result.idempotent_replay }));
      `;
      const options = { cwd: process.cwd(), maxBuffer: 1024 * 1024 };
      const [first, second] = await Promise.all([
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script, storePath, "shared-device"],
          options
        ),
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script, storePath, "shared-device"],
          options
        )
      ]);
      const results = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as Array<{ id: string; replay: boolean }>;

      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.map((result) => result.replay).sort()).toEqual([false, true]);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each(["private", "PRIVATE", "Secret", "sEnSiTiVe"])(
    "hides %s checkpoint recovery by default",
    async (privateTag) => {
      await withInitializedTempStore(async (storePath) => {
        const engine = createTestEngine(storePath);
        const result = await engine.checkpoint({
          project_id: "project-a",
          ...authored,
          delta: baseDelta,
          tags: [privateTag]
        });

        expect(result.recovery_pack.available).toBe(false);
        expect(result.recovery_pack).not.toHaveProperty("checkpoint");
      });
    }
  );

  it("versions checkpoint content and ignores malformed manual checkpoint records", async () => {
    await withInitializedTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_manual",
        op: "upsert_record",
        created_at: "2026-07-10T00:00:00.000Z",
        source: { client: "codex", session_id: "session-1" },
        record: {
          id: "rec_manual",
          kind: "session_summary",
          type: "checkpoint",
          scope: "project",
          project_id: "project-a",
          tags: ["checkpoint", "session:session-1", "checkpoint:checkpoint-1"],
          content: {
            format: "json",
            text: "manual",
            checkpoint_version: 1,
            checkpoint: { session_id: "session-1", checkpoint_id: "checkpoint-1" }
          },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-07-10T00:00:00.000Z",
          updated_at: "2026-07-10T00:00:00.000Z",
          ...authored,
          provenance: { method: "agent-proposed" }
        }
      });
      const engine = createTestEngine(storePath);

      const result = await engine.checkpoint({
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      });

      expect(result.idempotent_replay).toBe(false);
      expect(result.record.id).not.toBe("rec_manual");
      expect(result.record.content.checkpoint_version).toBe(1);
      expect(result.recovery_pack.available).toBe(true);
      expect(await readEvents(storePath)).toHaveLength(2);
    });
  });

  it("returns unavailable recovery for malformed checkpoint content", () => {
    const pack = recoveryPack(
      {
        id: "rec_bad",
        kind: "session_summary",
        type: "checkpoint",
        scope: "project",
        project_id: "project-a",
        tags: [],
        content: { format: "json", checkpoint_version: 1, checkpoint: { session_id: "session-1" } },
        state: "candidate",
        confidence: 0.5,
        priority: "normal",
        visibility: "active",
        created_at: "2026-07-11T00:00:00.000Z",
        updated_at: "2026-07-11T00:00:00.000Z",
        source: { client: "codex", session_id: "session-1" },
        provenance: { method: "agent-proposed" }
      },
      true
    );

    expect(pack).toMatchObject({
      available: false,
      session_id: "session-1",
      source_record_ids: [],
      checkpoint_count: 0
    });
    expect(pack).not.toHaveProperty("checkpoint");
  });

  it("returns committed checkpoint when derived view rebuild fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-11T00:00:00.000Z",
        id: (() => {
          let sequence = 0;
          return (prefix: string) => `${prefix}_${++sequence}`;
        })(),
        rebuild: async () => {
          throw new Error("rebuild failed");
        }
      });
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first).toMatchObject({
        committed: true,
        derived_views_refreshed: false,
        warnings: [{ code: "DERIVED_VIEW_REBUILD_FAILED" }]
      });
      expect(replay).toMatchObject({
        committed: true,
        idempotent_replay: true,
        derived_views_refreshed: false,
        warnings: [{ code: "DERIVED_VIEW_REBUILD_FAILED" }]
      });
      expect(replay.record.id).toBe(first.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("returns the immediately aggregated recovery pack from replayed events even when rebuild fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        rebuild: async () => {
          throw new Error("rebuild failed");
        }
      });
      const source = { client: "codex", session_id: "session-1", device_id: "device-test" };
      await engine.checkpoint({
        project_id: "project-a",
        source,
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { ...baseDelta, checkpoint_id: "checkpoint-1", progress: ["first"] }
      });
      const second = await engine.checkpoint({
        project_id: "project-a",
        source,
        occurred_at: "2026-07-11T00:01:00.000Z",
        delta: { ...baseDelta, checkpoint_id: "checkpoint-2", current_task: "Latest task", progress: ["second"] }
      });

      expect(second.recovery_pack).toMatchObject({
        available: true,
        checkpoint_count: 2,
        latest_checkpoint_id: "checkpoint-2",
        source_record_ids: expect.arrayContaining([second.record.id]),
        current_task: "Latest task",
        progress: ["first", "second"]
      });
    });
  });

  it("rejects sensitive checkpoint content without appending an event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const delta = { ...baseDelta, current_task: "Use api_key=abcdefghijklmnop" };

      await expect(engine.checkpoint({ project_id: "project-a", ...authored, delta })).rejects.toThrow(
        /Sensitive content detected/i
      );
      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("keeps the deterministic idempotency key after archive or quarantine", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: baseDelta
      };

      const archived = await engine.checkpoint(input);
      await engine.archive({ record_id: archived.record.id, source: input.source });
      const afterArchive = await engine.checkpoint(input);
      await engine.quarantine({ record_id: afterArchive.record.id, source: input.source, reason: "test boundary" });
      const afterQuarantine = await engine.checkpoint(input);

      expect(afterArchive.idempotent_replay).toBe(true);
      expect(afterQuarantine.idempotent_replay).toBe(true);
      expect(new Set([archived.record.id, afterArchive.record.id, afterQuarantine.record.id]).size).toBe(1);
    });
  });
});
