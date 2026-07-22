import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { estimateMemoryRecordTokens } from "../../src/core/record-read-model.js";
import { writeSoulCompilationReceipt } from "../../src/core/soul-compilation-receipts.js";
import { writeSoulDeliveryReceipt } from "../../src/core/soul-delivery-receipts.js";
import { compileEffectiveSoul } from "../../src/core/soul-profile.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { readSoulProfileRevisions } from "../../src/core/soul-profile-store.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import type { MorynRecord } from "../../src/core/types.js";
import { buildDashboardData, renderDashboardHtml } from "../../src/observability/dashboard.js";
import { buildDashboardMemoryMaintenance, buildDashboardSoulStudio } from "../../src/observability/dashboard-v04.js";
import { withTempStore } from "../helpers/temp-store.js";

function record(input: {
  id: string;
  kind?: MorynRecord["kind"];
  type: string;
  scope?: MorynRecord["scope"];
  state?: MorynRecord["state"];
  visibility?: MorynRecord["visibility"];
  content?: MorynRecord["content"];
  source_session?: string;
}): MorynRecord {
  return {
    id: input.id,
    kind: input.kind ?? "memory",
    type: input.type,
    scope: input.scope ?? "project",
    ...(input.scope === "global" ? {} : { project_id: "moryn" }),
    tags: [],
    content: input.content ?? { format: "text", text: input.id },
    state: input.state ?? "candidate",
    confidence: 0.8,
    priority: "normal",
    visibility: input.visibility ?? "active",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    source: {
      client: "codex",
      ...(input.source_session ? { session_id: input.source_session } : {})
    }
  };
}

async function copyEvents(fromStorePath: string, toStorePath: string): Promise<void> {
  for (const event of await readEvents(fromStorePath)) await appendEventIfAbsent(toStorePath, event);
  await rebuildDerivedViews(toStorePath);
}

describe("v0.4 dashboard projections", () => {
  it("summarizes layers, retention, tokens, and planner queues without returning source payloads", () => {
    const privateMarker = "PRIVATE_MEMORY_PAYLOAD_MUST_NOT_LEAK";
    const records = [
      record({
        id: "rec_l0",
        kind: "agent_note",
        type: "observation",
        content: { format: "text", text: privateMarker }
      }),
      record({ id: "rec_l1", kind: "session_summary", type: "summary", source_session: "session-review" }),
      record({ id: "rec_l2", type: "decision", state: "canonical" }),
      record({ id: "rec_l3", type: "working_principle", scope: "global", state: "canonical" }),
      record({
        id: "rec_cold",
        kind: "agent_note",
        type: "observation",
        state: "archived",
        visibility: "archived"
      }),
      record({
        id: "rec_purged",
        kind: "agent_note",
        type: "observation",
        content: {
          format: "text",
          text: "ephemeral chatter",
          memory_retention: {
            version: 2,
            layer: "L0",
            trust_state: "raw",
            retention: { tier: "purged" }
          }
        },
        state: "raw"
      })
    ];

    const data = buildDashboardMemoryMaintenance(records, {
      project_id: "moryn",
      now: "2026-07-20T00:00:00.000Z"
    });

    expect(data.inventory).toMatchObject({
      records: 6,
      layers: { L0: 3, L1: 1, L2: 1, L3: 1 },
      tiers: { hot: 2, warm: 2, cold: 1, purged: 1 }
    });
    expect(data.tokens.total).toBe(records.reduce((total, item) => total + estimateMemoryRecordTokens(item), 0));
    expect(data.session_fold).toMatchObject({ total: 1, ready: 0, review_required: 1 });
    expect(data.episode_rollup.total).toBe(0);
    expect(data.safety).toMatchObject({
      mode: "preview_only",
      writes: "none",
      privacy: "aggregate_and_metadata_only",
      physical_purge_included: false
    });
    expect(data.tokens.physical_storage_deleted).toBe(0);
    expect(JSON.stringify(data)).not.toContain(privateMarker);
  });

  it("projects Episode Rollup as a metadata-only ready preview", () => {
    const privateMarker = "EPISODE_SOURCE_TEXT_MUST_NOT_LEAK";
    const source = record({
      id: "rec_session_rollup",
      kind: "session_summary",
      type: "session_rollup",
      source_session: "session-closed",
      content: {
        text: privateMarker,
        format: "json",
        session_fold_version: 1,
        closed_at: "2026-07-10T12:00:00.000Z",
        source_record_ids: ["rec_leaf"],
        source_digests: [{ record_id: "rec_leaf", digest: "a".repeat(64) }],
        decisions: ["Keep verified leaf lineage"],
        blockers: [],
        next_steps: [],
        changed_facts: [],
        important_files: []
      }
    });

    const data = buildDashboardMemoryMaintenance([source], {
      project_id: "moryn",
      now: "2026-07-20T12:00:00.000Z"
    });

    expect(data.episode_rollup).toMatchObject({
      total: 1,
      ready: 1,
      deferred: 0,
      review_required: 0,
      plans: [
        {
          status: "ready",
          scope: { kind: "day", key: "2026-07-10" },
          coverage: { source_records: 1, covered_records: 1, ratio: 1, verified: true },
          preview_only: true,
          sync_impact: "none_until_apply",
          undo: { physical_purge_included: false }
        }
      ]
    });
    expect(JSON.stringify(data)).not.toContain(privateMarker);
  });

  it("shows Soul revision, compilation, and delivery metadata without leaking local-only clause text", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-07-20T00:00:00.000Z",
        id: () => "device_dashboard_v04"
      });
      const privateClause = "LOCAL_ONLY_SOUL_CLAUSE_MUST_NEVER_ENTER_DASHBOARD";
      const source = { client: "codex", device_id: "device_dashboard_v04" };
      const draft = await createSoulProfileDraft(storePath, {
        subject: { kind: "user", subject_id: "default" },
        clauses: [
          {
            clause_key: "private-collaboration-style",
            category: "collaboration",
            text: privateClause,
            scope: { kind: "project", project_id: "moryn" },
            distribution: "local_only",
            mandatory: true,
            priority: 90
          }
        ],
        source,
        occurred_at: "2026-07-20T00:01:00.000Z"
      });
      const firstActivation = await approveSoulProfileDraft(storePath, {
        revision_id: draft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-20T00:02:00.000Z"
      });
      const nextPrivateClause = "SECOND_LOCAL_ONLY_SOUL_CLAUSE_MUST_NEVER_ENTER_DASHBOARD";
      const nextDraft = await createSoulProfileDraft(storePath, {
        from_revision_id: firstActivation.revision.revision_id,
        clauses: [
          {
            clause_key: "private-collaboration-style",
            category: "collaboration",
            text: nextPrivateClause,
            scope: { kind: "project", project_id: "moryn" },
            distribution: "local_only",
            mandatory: true,
            priority: 90
          }
        ],
        source,
        occurred_at: "2026-07-20T00:03:00.000Z"
      });
      const activation = await approveSoulProfileDraft(storePath, {
        revision_id: nextDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-20T00:04:00.000Z"
      });
      const loaded = await readSoulProfileRevisions(storePath);
      const effective = compileEffectiveSoul({ revisions: loaded.revisions, project_id: "moryn" });
      await writeSoulCompilationReceipt(storePath, effective, "2026-07-20T00:05:00.000Z");
      await writeSoulDeliveryReceipt(storePath, {
        profile_id: activation.revision.profile_id,
        source_revision_ids: effective.selected_revisions.map((revision) => revision.revision_id),
        source_digest: effective.source_digest,
        rendered_digest: effective.rendered_digest,
        host: "codex",
        project_id: "moryn",
        session_id: "session-dashboard-v04",
        device_id: "device_dashboard_v04",
        event: "session_start",
        occurred_at: "2026-07-20T00:06:00.000Z"
      });

      const data = await buildDashboardData(storePath, {
        project_id: "moryn",
        now: "2026-07-20T00:07:00.000Z"
      });
      const serialized = JSON.stringify(data);
      const html = renderDashboardHtml(data);

      expect(data.soul_studio).toMatchObject({
        read_only: true,
        summary: { profiles: 1, active: 2, conflicted: 0, personal_sync_saved: 0 },
        compilation: {
          status: "ready",
          deliverable: true,
          receipt: { found: true, current: true }
        },
        delivery: { host_context_prepared: true, current_receipts: 1 },
        privacy: {
          clause_payloads_exposed: false,
          local_only_clause_text_exposed: false,
          receipt_payloads: "metadata_only"
        }
      });
      expect(data.soul_studio.profiles[0]).toMatchObject({
        persistence: { local_saved: true, personal_sync_saved: false },
        rollback: {
          available: true,
          requires_confirmation: true,
          target_revision_ids: [firstActivation.revision.revision_id]
        }
      });
      expect(serialized).not.toContain(privateClause);
      expect(serialized).not.toContain(nextPrivateClause);
      expect(html).toContain("Memory Maintenance");
      expect(html).toContain("Soul Studio");
      expect(html).toContain('data-i18n-zh="记忆维护"');
      expect(html).not.toContain(privateClause);
      expect(html).not.toContain(nextPrivateClause);
    });
  });

  it("counts derived multi-head profile conflicts and exposes every verified rollback target", async () => {
    await withTempStore(async (leftStorePath) => {
      await withTempStore(async (rightStorePath) => {
        await initializeStore(leftStorePath, {
          now: () => "2026-07-20T01:00:00.000Z",
          id: () => "device_dashboard_left"
        });
        await initializeStore(rightStorePath, {
          now: () => "2026-07-20T01:00:00.000Z",
          id: () => "device_dashboard_right"
        });
        const leftSource = { client: "user", device_id: "device_dashboard_left" };
        const rightSource = { client: "user", device_id: "device_dashboard_right" };
        const baseDraft = await createSoulProfileDraft(leftStorePath, {
          subject: { kind: "agent", subject_id: "dashboard-conflict" },
          clauses: [
            {
              clause_key: "tone",
              category: "communication",
              text: "Use the shared approved tone.",
              distribution: "personal_sync"
            }
          ],
          source: leftSource,
          occurred_at: "2026-07-20T01:01:00.000Z"
        });
        const base = await approveSoulProfileDraft(leftStorePath, {
          revision_id: baseDraft.revision.revision_id,
          confirmed: true,
          source: leftSource,
          occurred_at: "2026-07-20T01:02:00.000Z"
        });
        await copyEvents(leftStorePath, rightStorePath);

        const leftDraft = await createSoulProfileDraft(leftStorePath, {
          from_revision_id: base.revision.revision_id,
          clauses: [{ ...base.revision.clauses[0]!, text: "Prefer the left branch tone." }],
          source: leftSource,
          occurred_at: "2026-07-20T01:03:00.000Z"
        });
        const left = await approveSoulProfileDraft(leftStorePath, {
          revision_id: leftDraft.revision.revision_id,
          confirmed: true,
          source: leftSource,
          occurred_at: "2026-07-20T01:04:00.000Z"
        });
        const rightDraft = await createSoulProfileDraft(rightStorePath, {
          from_revision_id: base.revision.revision_id,
          clauses: [{ ...base.revision.clauses[0]!, text: "Prefer the right branch tone." }],
          source: rightSource,
          occurred_at: "2026-07-20T01:03:30.000Z"
        });
        const right = await approveSoulProfileDraft(rightStorePath, {
          revision_id: rightDraft.revision.revision_id,
          confirmed: true,
          source: rightSource,
          occurred_at: "2026-07-20T01:04:30.000Z"
        });
        await copyEvents(rightStorePath, leftStorePath);

        const studio = await buildDashboardSoulStudio(leftStorePath, { project_id: "moryn" });
        const profile = studio.profiles[0]!;
        expect(studio.summary).toMatchObject({ profiles: 1, active: 3, conflicted: 1 });
        expect(profile).toMatchObject({
          conflicted: true,
          selection_status: "using_last_known_good",
          active_revision_id: base.revision.revision_id,
          states: { conflicted: 0 },
          rollback: { available: true, requires_confirmation: true }
        });
        expect(profile.head_revision_ids).toEqual([left.revision.revision_id, right.revision.revision_id].sort());
        expect(profile.rollback.target_revision_ids).toEqual([
          ...[left.revision.revision_id, right.revision.revision_id].sort(),
          base.revision.revision_id
        ]);
      });
    });
  });
});
