import { describe, expect, it } from "vitest";
import { checkpointPayloadDigest, checkpointSummary } from "../../src/core/checkpoint.js";
import { validateContextDelta } from "../../src/core/context-delta.js";
import { buildSessionFoldCoverageAttestation, planSessionFold, planSessionFolds } from "../../src/core/session-fold.js";
import type { MorynRecord } from "../../src/core/types.js";

interface TestRecordInput {
  id: string;
  type: string;
  at: string;
  project_id?: string;
  session_id?: string;
  client?: string;
  device_id?: string;
  tags?: string[];
  content?: MorynRecord["content"];
  visibility?: MorynRecord["visibility"];
  state?: MorynRecord["state"];
  priority?: MorynRecord["priority"];
  conflict?: MorynRecord["conflict"];
  links?: MorynRecord["links"];
}

function record(input: TestRecordInput): MorynRecord {
  const sessionId = input.session_id ?? "session-a";
  const projectId = input.project_id ?? "project-a";
  const tags = input.tags ?? [`session:${sessionId}`];
  const source = {
    client: input.client ?? "codex",
    session_id: sessionId,
    device_id: input.device_id ?? "device-a"
  };
  let content =
    input.content ??
    (input.type === "checkpoint"
      ? {
          text: input.id,
          format: "json" as const,
          checkpoint_version: 1,
          checkpoint: {
            session_id: sessionId,
            checkpoint_id: input.id,
            blockers: [],
            decisions: [],
            changed_facts: [],
            next_steps: [],
            files: []
          }
        }
      : { text: input.id, format: "text" as const });
  if (input.type === "checkpoint" && content.checkpoint && typeof content.checkpoint === "object") {
    try {
      const delta = validateContextDelta({ checkpoint_id: input.id, ...content.checkpoint });
      content = {
        ...content,
        text: checkpointSummary(delta),
        format: "json",
        checkpoint_version: 1,
        checkpoint_payload_digest: checkpointPayloadDigest({
          project_id: projectId,
          source,
          occurred_at: input.at,
          delta,
          tags,
          include_private: false
        }),
        checkpoint: delta
      };
    } catch {}
  }
  return {
    id: input.id,
    kind: "session_summary",
    type: input.type,
    scope: "project",
    project_id: projectId,
    tags,
    content,
    state: input.state ?? "candidate",
    confidence: 0.8,
    priority: input.priority ?? "normal",
    visibility: input.visibility ?? "active",
    created_at: input.at,
    updated_at: input.at,
    source,
    provenance: { method: "agent-proposed" },
    conflict: input.conflict,
    links: input.links
  };
}

function withCoverage(records: MorynRecord[]): MorynRecord[] {
  const final = [...records]
    .filter((candidate) => candidate.type === "summary" && typeof candidate.content.text === "string")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .at(-1);
  if (!final) return records;
  const identity = { project_id: final.project_id!, session_id: final.source.session_id! };
  const coverage = buildSessionFoldCoverageAttestation(
    records.filter((candidate) => candidate.id !== final.id),
    identity,
    String(final.content.text)
  );
  return records.map((candidate) =>
    candidate.id === final.id
      ? { ...candidate, content: { ...candidate.content, session_fold_coverage: coverage } }
      : candidate
  );
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 6, 20, 0, 0, second)).toISOString();
}

describe("session fold planning", () => {
  it("builds a deterministic closed-session rollup and keeps exactly one active episodic target", () => {
    const records = withCoverage([
      record({
        id: "status-1",
        type: "status",
        at: at(1),
        content: {
          text: "Implementation in progress",
          current_task: "Implement session folding",
          decisions: ["Use deterministic source digests"]
        }
      }),
      record({
        id: "checkpoint-1",
        type: "checkpoint",
        at: at(2),
        content: {
          text: "First checkpoint",
          checkpoint_version: 1,
          checkpoint: {
            session_id: "session-a",
            checkpoint_id: "checkpoint-1",
            current_task: "Implement session folding",
            blockers: ["Need a final handoff"],
            decisions: ["Use deterministic source digests"],
            changed_facts: ["Status records are append-only"],
            next_steps: ["Write the final handoff"],
            files: ["src/core/session-fold.ts"]
          }
        }
      }),
      record({
        id: "checkpoint-2",
        type: "checkpoint",
        at: at(3),
        client: "claude",
        device_id: "device-b",
        content: {
          text: "Latest checkpoint",
          checkpoint_version: 1,
          checkpoint: {
            session_id: "session-a",
            checkpoint_id: "checkpoint-2",
            current_task: "Implement session folding",
            blockers: [],
            decisions: ["Keep one final handoff hot", "Use deterministic source digests"],
            changed_facts: ["The final handoff closes a session"],
            next_steps: ["Verify the fold plan"],
            files: ["tests/core/session-fold.test.ts", "src/core/session-fold.ts"]
          }
        }
      }),
      record({
        id: "summary-hot",
        type: "summary",
        at: at(4),
        content: {
          text: "Implementation in progress. Session folding is implemented and verified.",
          synthesis_current_task: "Implement session folding",
          synthesis_blockers: ["Release review remains"],
          synthesis_decisions: ["Keep one final handoff hot"],
          synthesis_next_steps: ["Monitor the first applied fold"]
        }
      })
    ]);

    const first = planSessionFold(records, { project_id: "project-a", session_id: "session-a" });
    const reordered = planSessionFold([...records].reverse(), {
      project_id: "project-a",
      session_id: "session-a"
    });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      version: 1,
      plan_id: expect.stringMatching(/^session_fold_[a-f0-9]{32}$/),
      identity: { project_id: "project-a", session_id: "session-a" },
      status: "ready",
      auto_fold: true,
      closed: true,
      privacy_boundary: "public",
      hot_final_handoff: {
        record_id: "summary-hot",
        text: "Implementation in progress. Session folding is implemented and verified."
      },
      review_reasons: [],
      coverage: {
        total_source_records: 4,
        covered_source_records: 4,
        coverage_ratio: 1,
        status_updates: 1,
        checkpoints: 2,
        final_summaries: 1,
        proposed_active_targets: 1
      }
    });
    expect(first?.archive_candidates.map((candidate) => candidate.record_id)).toEqual([
      "status-1",
      "checkpoint-1",
      "checkpoint-2"
    ]);
    expect(first?.cold_candidates).toEqual([
      { record_id: "summary-hot", type: "summary", reason: "covered_by_rollup" }
    ]);
    expect(first?.proposed_active_target_record_ids).toEqual([
      expect.stringMatching(/^rec_session_fold_[a-f0-9]{32}$/)
    ]);
    expect(first?.rollup_record?.content).toMatchObject({
      text: "Implementation in progress. Session folding is implemented and verified.",
      current_task: "Implement session folding",
      blockers: ["Release review remains"],
      decisions: ["Use deterministic source digests", "Keep one final handoff hot"],
      changed_facts: ["Status records are append-only", "The final handoff closes a session"],
      next_steps: ["Monitor the first applied fold"],
      important_files: ["src/core/session-fold.ts", "tests/core/session-fold.test.ts"],
      source_record_ids: ["status-1", "checkpoint-1", "checkpoint-2", "summary-hot"]
    });
    expect(first?.source_identities).toHaveLength(2);
    expect(first?.source_digests).toHaveLength(4);
    expect(first?.source_digests.every((source) => /^[a-f0-9]{64}$/.test(source.digest))).toBe(true);
    expect(first?.rollup_record?.provenance?.derived_from).toEqual(first?.source_record_ids);
  });

  it("lets a newer status supersede earlier ordinary status text while requiring the latest status in the final", () => {
    const earlier = record({ id: "status-earlier", type: "status", at: at(1) });
    const latest = record({ id: "status-latest", type: "status", at: at(2) });
    const final = record({
      id: "summary-hot",
      type: "summary",
      at: at(3),
      content: { text: "status-latest is complete", format: "text" }
    });
    const covered = withCoverage([earlier, latest, final]);
    const plan = planSessionFold(covered, { project_id: "project-a", session_id: "session-a" });
    const coverage = covered.find((candidate) => candidate.id === final.id)!.content.session_fold_coverage as {
      covered_sources: Array<{ record_id: string; method: string }>;
    };

    expect(coverage.covered_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ record_id: earlier.id, method: "newer_status_supersession" }),
        expect.objectContaining({ record_id: latest.id, method: "verbatim_final_projection" })
      ])
    );
    expect(plan).toMatchObject({ status: "ready", auto_fold: true, review_reasons: [] });

    const latestMissingFromFinal = withCoverage([
      earlier,
      latest,
      { ...final, content: { text: "A different final summary", format: "text" } }
    ]);
    const blocked = planSessionFold(latestMissingFromFinal, {
      project_id: "project-a",
      session_id: "session-a"
    });
    expect(blocked).toMatchObject({ status: "review_required", auto_fold: false });
    expect(blocked?.review_reasons.map((reason) => reason.code)).toContain("unverified_source_coverage");
  });

  it("separates project and session groups and ignores inactive or unrelated records", () => {
    const records = [
      record({ id: "a-status", type: "status", at: at(1) }),
      record({ id: "a-final", type: "summary", at: at(2) }),
      record({ id: "b-status", type: "status", at: at(3), session_id: "session-b" }),
      record({ id: "b-final", type: "summary", at: at(4), session_id: "session-b" }),
      record({ id: "other-status", type: "status", at: at(5), project_id: "project-b" }),
      record({ id: "other-final", type: "summary", at: at(6), project_id: "project-b" }),
      record({ id: "archived", type: "status", at: at(7), visibility: "archived", state: "archived" }),
      { ...record({ id: "not-session-summary", type: "status", at: at(8) }), kind: "agent_note" as const }
    ];

    expect(planSessionFolds(records).map((plan) => plan.identity)).toEqual([
      { project_id: "project-a", session_id: "session-a" },
      { project_id: "project-a", session_id: "session-b" },
      { project_id: "project-b", session_id: "session-a" }
    ]);
    expect(planSessionFolds(records, { project_id: "project-a" })).toHaveLength(2);
    expect(planSessionFold(records, { project_id: "project-a", session_id: "session-a" })?.source_record_ids).toEqual([
      "a-status",
      "a-final"
    ]);
    expect(planSessionFold(records, { project_id: "project-a", session_id: "missing" })).toBeUndefined();
  });

  it("does not auto-fold a session without a valid final summary", () => {
    const plan = planSessionFold(
      [
        record({ id: "status", type: "status", at: at(1) }),
        record({ id: "empty-final", type: "summary", at: at(2), content: { text: "  " } })
      ],
      { project_id: "project-a", session_id: "session-a" }
    );

    expect(plan).toMatchObject({
      status: "review_required",
      auto_fold: false,
      closed: false,
      proposed_active_target_record_ids: [],
      review_reasons: expect.arrayContaining([expect.objectContaining({ code: "no_final_summary" })])
    });
    expect(plan).not.toHaveProperty("rollup_record");
  });

  it("treats updates after the final handoff as an unfinished session", () => {
    const plan = planSessionFold(
      [
        record({ id: "final", type: "summary", at: at(1), content: { text: "Premature final" } }),
        record({ id: "late-status", type: "status", at: at(2) })
      ],
      { project_id: "project-a", session_id: "session-a" }
    );

    expect(plan).toMatchObject({
      auto_fold: false,
      closed: false,
      hot_final_handoff: { record_id: "final" },
      review_reasons: expect.arrayContaining([
        {
          code: "updates_after_final",
          message: expect.any(String),
          record_ids: ["final", "late-status"]
        }
      ])
    });
  });

  it("requires review for conflicts, quarantined evidence, and malformed checkpoints", () => {
    const plan = planSessionFold(
      withCoverage([
        record({
          id: "conflicted",
          type: "status",
          at: at(1),
          conflict: { kind: "semantic", with: ["other"], resolution: "needs_review" }
        }),
        record({
          id: "quarantined",
          type: "status",
          at: at(2),
          visibility: "quarantined",
          state: "quarantined"
        }),
        record({ id: "bad-checkpoint", type: "checkpoint", at: at(3), content: { text: "bad" } }),
        record({ id: "final", type: "summary", at: at(4), content: { text: "Final handoff" } })
      ]),
      { project_id: "project-a", session_id: "session-a" }
    );

    expect(plan?.auto_fold).toBe(false);
    expect(plan?.review_reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["unresolved_conflict", "quarantined_source", "invalid_checkpoint_content"])
    );
    expect(plan).not.toHaveProperty("rollup_record");
  });

  it("does not silently fold protected commands, paths, dates, or requirements", () => {
    const identity = { project_id: "project-a", session_id: "session-a" };
    const protectedStatus = record({
      id: "protected-status",
      type: "status",
      at: at(1),
      content: { text: "Must run npm test before editing /workspace/Moryn on 2026-07-20." }
    });
    const finalText = String(protectedStatus.content.text);
    const coverage = buildSessionFoldCoverageAttestation([protectedStatus], identity, finalText);
    const final = record({
      id: "final",
      type: "summary",
      at: at(2),
      content: { text: finalText, session_fold_coverage: coverage }
    });

    const plan = planSessionFold([protectedStatus, final], identity);
    expect(plan).toMatchObject({ status: "review_required", auto_fold: false });
    expect(plan?.review_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_retention_source", record_ids: [protectedStatus.id] }),
        expect.objectContaining({ code: "unverified_source_coverage", record_ids: [protectedStatus.id] })
      ])
    );
    expect(coverage.uncovered_sources[0]).toMatchObject({
      record_id: protectedStatus.id,
      blockers: expect.arrayContaining(["protected_content"])
    });
  });

  it("blocks mixed public/private folds but keeps an entirely private fold private", () => {
    const mixed = planSessionFold(
      [
        record({ id: "public-status", type: "status", at: at(1) }),
        record({ id: "private-final", type: "summary", at: at(2), tags: ["private"] })
      ],
      { project_id: "project-a", session_id: "session-a" }
    );
    expect(mixed).toMatchObject({
      privacy_boundary: "mixed",
      auto_fold: false,
      review_reasons: expect.arrayContaining([expect.objectContaining({ code: "mixed_privacy_boundary" })])
    });

    const allPrivate = planSessionFold(
      withCoverage([
        record({
          id: "private-status",
          type: "status",
          at: at(1),
          tags: ["private"],
          content: { text: "Private progress" }
        }),
        record({
          id: "private-final",
          type: "summary",
          at: at(2),
          tags: ["private"],
          content: { text: "Private progress is complete" }
        })
      ]),
      { project_id: "project-a", session_id: "session-a" }
    );
    expect(allPrivate).toMatchObject({ privacy_boundary: "private", auto_fold: true, review_reasons: [] });
    expect(allPrivate?.rollup_record?.tags).toContain("private");
    expect(allPrivate?.source_digests.every((source) => source.privacy === "private")).toBe(true);
  });

  it("uses latest explicit blocker/next-step snapshots while retaining durable facts, decisions, and files", () => {
    const plan = planSessionFold(
      withCoverage([
        record({
          id: "checkpoint-old",
          type: "checkpoint",
          at: at(1),
          content: {
            checkpoint: {
              session_id: "session-a",
              current_task: "Keep durable facts",
              blockers: ["Resolved blocker"],
              decisions: ["Decision A"],
              changed_facts: ["Fact A"],
              next_steps: ["Obsolete step"],
              files: ["a.ts"]
            }
          }
        }),
        record({
          id: "checkpoint-new",
          type: "checkpoint",
          at: at(2),
          content: {
            checkpoint: {
              session_id: "session-a",
              current_task: "Keep durable facts",
              blockers: [],
              decisions: ["Decision A", "Decision B"],
              changed_facts: ["Fact B"],
              next_steps: ["Current step"],
              files: ["b.ts", "a.ts"]
            }
          }
        }),
        record({ id: "final", type: "summary", at: at(3), content: { text: "Done" } })
      ]),
      { project_id: "project-a", session_id: "session-a" }
    );

    expect(plan?.rollup_record?.content).toMatchObject({
      blockers: [],
      decisions: ["Decision A", "Decision B"],
      changed_facts: ["Fact A", "Fact B"],
      next_steps: ["Current step"],
      important_files: ["a.ts", "b.ts"]
    });
  });

  it("folds one hundred verified structured checkpoints into one active target", () => {
    const updates = Array.from({ length: 100 }, (_, index) =>
      record({
        id: `checkpoint-${String(index + 1).padStart(3, "0")}`,
        type: "checkpoint",
        at: at(index),
        content: {
          checkpoint: {
            session_id: "session-a",
            current_task: "Verify structured folding",
            decisions: [`Decision ${index + 1}`]
          }
        }
      })
    );
    const final = record({ id: "final", type: "summary", at: at(120), content: { text: "Final handoff" } });
    const plan = planSessionFold(withCoverage([...updates, final]), {
      project_id: "project-a",
      session_id: "session-a"
    });

    expect(plan).toMatchObject({
      auto_fold: true,
      coverage: {
        total_source_records: 101,
        covered_source_records: 101,
        coverage_ratio: 1,
        status_updates: 0,
        checkpoints: 100,
        proposed_active_targets: 1
      }
    });
    expect(plan?.archive_candidates).toHaveLength(100);
    expect(plan?.proposed_active_target_record_ids).toHaveLength(1);
    expect(plan?.rollup_record?.content.source_record_ids).toHaveLength(101);
    expect(plan?.rollup_record?.content.decisions).toHaveLength(100);
  });

  it.each([
    {
      name: "non-verbatim status",
      source: record({ id: "plain-status", type: "status", at: at(1), content: { text: "Unverified detail" } }),
      reason: "unverified_source_coverage"
    },
    {
      name: "high-priority checkpoint",
      source: record({
        id: "high-checkpoint",
        type: "checkpoint",
        at: at(1),
        priority: "high",
        content: { checkpoint: { current_task: "Protect evidence", decisions: ["Keep this source"] } }
      }),
      reason: "unsafe_retention_source"
    },
    {
      name: "unique protected checkpoint",
      source: record({
        id: "protected-checkpoint",
        type: "checkpoint",
        at: at(1),
        tags: ["unique-evidence"],
        content: { checkpoint: { current_task: "Protect evidence", decisions: ["Keep this source"] } }
      }),
      reason: "unsafe_retention_source"
    }
  ])("keeps $name active for review", ({ source, reason }) => {
    const final = record({ id: "safe-final", type: "summary", at: at(2), content: { text: "Safe final" } });
    const plan = planSessionFold(withCoverage([source, final]), {
      project_id: "project-a",
      session_id: "session-a"
    });

    expect(plan).toMatchObject({ auto_fold: false, status: "review_required" });
    expect(plan?.review_reasons.map((item) => item.code)).toContain(reason);
    expect(plan?.proposed_active_target_record_ids).toEqual([]);
  });

  it("changes deterministic identities when covered source content changes", () => {
    const records = [
      record({ id: "status", type: "status", at: at(1), content: { text: "Before" } }),
      record({ id: "final", type: "summary", at: at(2), content: { text: "Final" } })
    ];
    const before = planSessionFold(records, { project_id: "project-a", session_id: "session-a" });
    const after = planSessionFold([{ ...records[0]!, content: { text: "After" } }, records[1]!], {
      project_id: "project-a",
      session_id: "session-a"
    });

    expect(before?.plan_id).not.toBe(after?.plan_id);
    expect(before?.source_digest).not.toBe(after?.source_digest);
    expect(before?.source_digests[0]?.digest).not.toBe(after?.source_digests[0]?.digest);
  });
});
