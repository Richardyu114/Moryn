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
import {
  buildDashboardData,
  type DashboardRecordSummary,
  renderDashboardHtml
} from "../../src/observability/dashboard.js";
import { dashboardDrawerId } from "../../src/observability/dashboard-drawer-id.js";
import {
  buildDashboardMemoryMaintenance,
  buildDashboardSoulStudio,
  type DashboardCompactionPlanPreview
} from "../../src/observability/dashboard-v04.js";
import { renderMemoryMaintenance } from "../../src/observability/dashboard-v04-workspace.js";
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
      now: "2026-07-20T00:00:00.000Z",
      visible_record_ids: new Set(records.map((item) => item.id))
    });

    expect(data.scope).toEqual({ mode: "project", project_id: "moryn", includes_global: true });
    expect(data.inventory).toMatchObject({
      records: 6,
      layers: { L0: 3, L1: 1, L2: 1, L3: 1 },
      tiers: { hot: 2, warm: 2, cold: 1, purged: 1 }
    });
    expect(data.tokens.total).toBe(records.reduce((total, item) => total + estimateMemoryRecordTokens(item), 0));
    expect(data.session_fold).toMatchObject({ total: 1, ready: 0, review_required: 1 });
    expect(data.session_fold.plans[0]?.related_records).toEqual({
      total: 1,
      visible: 1,
      hidden: 0,
      record_ids: ["rec_l1"],
      truncated: false
    });
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
      now: "2026-07-20T12:00:00.000Z",
      visible_record_ids: new Set([source.id])
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
          related_records: {
            total: 1,
            visible: 1,
            hidden: 0,
            record_ids: ["rec_session_rollup"],
            truncated: false
          },
          sync_impact: "none_until_apply",
          undo: { physical_purge_included: false }
        }
      ]
    });
    expect(JSON.stringify(data)).not.toContain(privateMarker);

    const hidden = buildDashboardMemoryMaintenance([source], {
      project_id: "moryn",
      now: "2026-07-20T12:00:00.000Z",
      visible_record_ids: new Set()
    });
    expect(hidden.episode_rollup).toMatchObject({
      total: 1,
      ready: 1,
      hidden_plans: 1,
      plans: []
    });
  });

  it("renders plain-language results before closed diagnostics and links visible source content safely", () => {
    const source = record({
      id: "rec_visible_source",
      kind: "session_summary",
      type: "session_rollup",
      source_session: "session-visible",
      content: {
        text: "Visible source <script>alert('no')</script>",
        format: "json",
        session_fold_version: 1,
        closed_at: "2026-07-10T12:00:00.000Z",
        source_record_ids: ["rec_leaf"],
        source_digests: [{ record_id: "rec_leaf", digest: "a".repeat(64) }],
        decisions: ["Keep verified lineage"],
        blockers: [],
        next_steps: [],
        changed_facts: [],
        important_files: []
      }
    });
    const data = buildDashboardMemoryMaintenance([source], {
      project_id: "moryn",
      now: "2026-07-20T12:00:00.000Z",
      visible_record_ids: new Set([source.id])
    });
    const html = renderMemoryMaintenance(data, [
      {
        id: source.id,
        kind: source.kind,
        type: source.type,
        scope: source.scope,
        project_id: source.project_id,
        state: source.state,
        priority: source.priority,
        source: source.source,
        created_at: source.created_at,
        updated_at: source.updated_at,
        text: source.content.text ?? "",
        citation: {
          record_id: source.id,
          timeline_command: `moryn timeline --record-id ${source.id}`,
          recall_command: `moryn recall --record-id ${source.id}`
        }
      }
    ]);

    expect(html.indexOf("data-v04-summary")).toBeLessThan(html.indexOf("data-v04-diagnostics"));
    expect(html).toContain("Moryn found memories that can be organized");
    expect(html).toContain("Combine completed session notes");
    expect(html).toContain(`data-v04-source data-drawer-target="${dashboardDrawerId("record", source.id)}"`);
    expect(html).toContain("Visible source &lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('no')</script>");
    expect(html).toContain('<details class="v04-diagnostics" data-v04-diagnostics>');
    expect(html).not.toContain('<details class="v04-diagnostics" data-v04-diagnostics open>');
    expect(html).not.toContain("data-decision-action");
  });

  it("embeds drawers only for source records rendered by the bounded plan preview", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-07-20T00:00:00.000Z",
        id: () => "device_bounded_plan_drawers"
      });
      const data = await buildDashboardData(storePath, {
        project_id: "moryn",
        now: "2026-07-20T12:00:00.000Z"
      });
      const summary = (id: string, text: string): DashboardRecordSummary => ({
        id,
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        state: "canonical",
        priority: "normal",
        source: { client: "codex" },
        created_at: "2026-07-10T12:00:00.000Z",
        updated_at: "2026-07-10T12:00:00.000Z",
        text,
        citation: {
          record_id: id,
          timeline_command: `moryn timeline --record-id ${id}`,
          recall_command: `moryn recall --record-id ${id}`
        }
      });
      // Keep plan sources beyond the normal search-result cap so any source
      // body or drawer below must have been selected by the v0.4 plan preview.
      const searchFillers = Array.from({ length: 600 }, (_, index) =>
        summary(`rec_search_filler_${String(index + 1).padStart(3, "0")}`, `Search filler ${index + 1}`)
      );
      const planSources = Array.from({ length: 9 }, (_, planIndex) =>
        Array.from({ length: 4 }, (_, sourceIndex) => {
          const planNumber = String(planIndex + 1).padStart(2, "0");
          const sourceNumber = String(sourceIndex + 1).padStart(2, "0");
          return summary(
            `rec_plan_${planNumber}_source_${sourceNumber}`,
            `PLAN_${planNumber}_SOURCE_${sourceNumber}_FULL_TEXT`
          );
        })
      );
      const plans: DashboardCompactionPlanPreview[] = planSources.map((sources, index) => ({
        plan_id: `episode_rollup_preview_${String(index + 1).padStart(2, "0")}`,
        status: "ready",
        scope: {
          project_id: "moryn",
          kind: "day",
          key: `2026-07-${String(index + 1).padStart(2, "0")}`
        },
        privacy_boundary: "public",
        coverage: { source_records: 4, covered_records: 4, ratio: 1, verified: true },
        token_estimate: { before: 400, after: 100, reducible: 300 },
        candidates: { cold: 4, warm: 0, archive: 0 },
        review_codes: [],
        deferred_codes: [],
        related_records: {
          total: 4,
          visible: 4,
          hidden: 0,
          record_ids: sources.map((source) => source.id),
          truncated: false
        },
        preview_only: true,
        sync_impact: "none_until_apply",
        undo: {
          available_after_apply: true,
          window: "while_append_only_source_history_is_retained",
          physical_purge_included: false
        }
      }));
      const fixture = {
        ...data,
        all_records: [...searchFillers, ...planSources.flat()],
        memory_maintenance: {
          ...data.memory_maintenance,
          inventory: {
            ...data.memory_maintenance.inventory,
            records: searchFillers.length + planSources.flat().length
          },
          episode_rollup: {
            total: plans.length,
            ready: plans.length,
            deferred: 0,
            review_required: 0,
            hidden_plans: 0,
            plans
          }
        }
      };

      const html = renderDashboardHtml(fixture);
      const targetCounts = new Map<string, number>();
      const payloadCounts = new Map<string, number>();
      for (const [, target] of html.matchAll(/data-drawer-target="([^"]+)"/gu)) {
        if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
      }
      for (const [, payload] of html.matchAll(/data-drawer-payload="([^"]+)"/gu)) {
        if (payload) payloadCounts.set(payload, (payloadCounts.get(payload) ?? 0) + 1);
      }

      expect(html.match(/<article class="v04-card v04-plan-card">/gu) ?? []).toHaveLength(8);
      expect(html.match(/<button[^>]+data-v04-source[^>]*>/gu) ?? []).toHaveLength(24);
      expect(html).toContain("Showing 8 of 9 suggestions.");
      for (const target of targetCounts.keys()) expect(payloadCounts.get(target)).toBe(1);

      const renderedSources = planSources.slice(0, 8).flatMap((sources) => sources.slice(0, 3));
      for (const source of renderedSources) {
        const drawerId = dashboardDrawerId("record", source.id);
        expect(targetCounts.get(drawerId)).toBe(1);
        expect(payloadCounts.get(drawerId)).toBe(1);
        expect(html).toContain(source.text);
      }

      const omittedSources = [...planSources.slice(0, 8).map((sources) => sources[3]!), ...planSources[8]!];
      for (const source of omittedSources) {
        const drawerId = dashboardDrawerId("record", source.id);
        expect(targetCounts.has(drawerId)).toBe(false);
        expect(payloadCounts.has(drawerId)).toBe(false);
        expect(html).not.toContain(source.text);
      }
    });
  });

  it("keeps private compaction sources out of related-record links until explicitly included", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-07-20T00:00:00.000Z",
        id: () => "device_private_plan"
      });
      const privateEpisodeMarker = "PRIVATE_COMPACTION_SOURCE_MUST_NOT_LEAK";
      const privateEpisodeSource: MorynRecord = {
        ...record({
          id: "rec_private_session_rollup",
          kind: "session_summary",
          type: "session_rollup",
          source_session: "private-plan-session",
          content: {
            text: privateEpisodeMarker,
            format: "json",
            session_fold_version: 1,
            closed_at: "2026-07-10T12:00:00.000Z",
            source_record_ids: ["rec_private_leaf"],
            source_digests: [{ record_id: "rec_private_leaf", digest: "b".repeat(64) }],
            decisions: ["Keep private lineage private"],
            blockers: [],
            next_steps: [],
            changed_facts: [],
            important_files: []
          }
        }),
        tags: ["private"]
      };
      const privateFoldMarker = "PRIVATE_SESSION_FOLD_BODY_MUST_NOT_LEAK";
      const privateFoldSource: MorynRecord = {
        ...record({
          id: "rec_private_session_fold",
          kind: "session_summary",
          type: "summary",
          source_session: "private-fold-session-must-not-leak",
          content: { text: privateFoldMarker, format: "text" }
        }),
        tags: ["private"]
      };
      await appendEventIfAbsent(storePath, {
        event_id: "evt_private_session_rollup",
        op: "upsert_record",
        record: privateEpisodeSource,
        created_at: privateEpisodeSource.created_at,
        source: privateEpisodeSource.source
      });
      await appendEventIfAbsent(storePath, {
        event_id: "evt_private_session_fold",
        op: "upsert_record",
        record: privateFoldSource,
        created_at: privateFoldSource.created_at,
        source: privateFoldSource.source
      });
      await rebuildDerivedViews(storePath);

      const safe = await buildDashboardData(storePath, {
        project_id: "moryn",
        now: "2026-07-20T12:00:00.000Z"
      });
      expect(safe.memory_maintenance.episode_rollup).toMatchObject({
        total: 1,
        hidden_plans: 1,
        plans: []
      });
      expect(safe.memory_maintenance.session_fold).toMatchObject({
        total: 1,
        hidden_plans: 1,
        plans: []
      });
      const serializedSafe = JSON.stringify(safe);
      expect(serializedSafe).not.toContain(privateEpisodeMarker);
      expect(serializedSafe).not.toContain(privateEpisodeSource.id);
      expect(serializedSafe).not.toContain("private-plan-session");
      expect(serializedSafe).not.toContain(privateFoldMarker);
      expect(serializedSafe).not.toContain(privateFoldSource.id);
      expect(serializedSafe).not.toContain("private-fold-session-must-not-leak");
      const safeHtml = renderDashboardHtml(safe);
      expect(safeHtml).not.toContain("private-plan-session");
      expect(safeHtml).not.toContain("private-fold-session-must-not-leak");

      const included = await buildDashboardData(storePath, {
        project_id: "moryn",
        include_private: true,
        now: "2026-07-20T12:00:00.000Z"
      });
      expect(included.memory_maintenance.episode_rollup.plans[0]?.related_records.record_ids).toEqual([
        privateEpisodeSource.id
      ]);
      expect(included.memory_maintenance.episode_rollup.hidden_plans).toBe(0);
      expect(included.memory_maintenance.session_fold.plans[0]).toMatchObject({
        scope: { key: "private-fold-session-must-not-leak" },
        related_records: { record_ids: [privateFoldSource.id] }
      });
      expect(included.memory_maintenance.session_fold.hidden_plans).toBe(0);
      const includedHtml = renderDashboardHtml(included);
      expect(includedHtml).toContain(privateEpisodeMarker);
      expect(includedHtml).toContain(privateFoldMarker);
    });
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
      expect(html).toContain("What Moryn remembers");
      expect(html).toContain("Collaboration preferences");
      expect(html).toContain('data-i18n-zh="协作偏好"');
      expect(html).toContain("approved preference version");
      expect(html).toContain("Preference text stays private.");
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
