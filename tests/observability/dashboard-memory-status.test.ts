import { describe, expect, it } from "vitest";
import type { MorynRecord } from "../../src/core/types.js";
import { buildDashboardMemoryStatus } from "../../src/observability/dashboard-memory-status.js";

function record(input: {
  id: string;
  project_id?: string;
  scope?: MorynRecord["scope"];
  kind?: MorynRecord["kind"];
  type?: string;
  tags?: string[];
  content?: MorynRecord["content"];
  state?: MorynRecord["state"];
  visibility?: MorynRecord["visibility"];
  updated_at?: string;
  links?: MorynRecord["links"];
}): MorynRecord {
  const scope = input.scope ?? "project";
  return {
    id: input.id,
    kind: input.kind ?? "memory",
    type: input.type ?? "fact",
    scope,
    ...(scope === "global" ? {} : { project_id: input.project_id ?? "project-a" }),
    tags: input.tags ?? [],
    content: input.content ?? { format: "text", text: input.id },
    state: input.state ?? "candidate",
    confidence: 0.8,
    priority: "normal",
    visibility: input.visibility ?? "active",
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: input.updated_at ?? "2026-07-24T00:00:00.000Z",
    source: { client: "codex" },
    ...(input.links ? { links: input.links } : {})
  };
}

function ids(records: readonly MorynRecord[]): string[] {
  return records.map((item) => item.id);
}

describe("dashboard memory status", () => {
  it("separates scoped usable, history, quarantine, absorbed learning, and pending inbox records", () => {
    const absorbed = record({ id: "rec_absorbed", tags: ["learning"] });
    const pending = record({
      id: "rec_pending",
      kind: "agent_note",
      type: "learning_inbox",
      tags: ["learning", "learning-inbox", "pending"],
      content: { learning_inbox_version: 1, status: "pending", text: "A pending discovery" }
    });
    const consumed = record({
      id: "rec_consumed",
      kind: "agent_note",
      type: "learning_inbox",
      tags: ["consumed", "learning", "learning-inbox"],
      content: { learning_inbox_version: 1, status: "consumed", text: "An absorbed inbox item" }
    });
    const archived = record({
      id: "rec_archived",
      tags: ["learning"],
      state: "archived",
      visibility: "archived"
    });
    const quarantined = record({
      id: "rec_quarantined",
      tags: ["learning"],
      state: "quarantined",
      visibility: "quarantined"
    });
    const globalLearning = record({ id: "rec_global", scope: "global", tags: ["learning"] });
    const ordinary = record({ id: "rec_ordinary" });
    const otherProject = record({ id: "rec_other", project_id: "project-b", tags: ["learning"] });
    const privateRecord = record({ id: "rec_private", tags: ["learning", "private"] });
    const privacyFilteredInput = [
      absorbed,
      pending,
      consumed,
      archived,
      quarantined,
      globalLearning,
      ordinary,
      otherProject,
      privateRecord
    ].filter((item) => !item.tags.includes("private"));

    const status = buildDashboardMemoryStatus(privacyFilteredInput, "project-a");

    expect(ids(status.scoped_records)).toEqual([
      "rec_absorbed",
      "rec_pending",
      "rec_consumed",
      "rec_archived",
      "rec_quarantined",
      "rec_global",
      "rec_ordinary"
    ]);
    expect(ids(status.usable_records)).toEqual([
      "rec_absorbed",
      "rec_pending",
      "rec_consumed",
      "rec_global",
      "rec_ordinary"
    ]);
    expect(ids(status.history_records)).toEqual(["rec_archived"]);
    expect(ids(status.quarantined_records)).toEqual(["rec_quarantined"]);
    expect(ids(status.logical_active_records)).toEqual(ids(status.usable_records));
    expect(ids(status.absorbed_learning_records)).toEqual(["rec_absorbed", "rec_global"]);
    expect(ids(status.pending_learning_inbox_records)).toEqual(["rec_pending"]);
    expect(JSON.stringify(status)).not.toContain("rec_other");
    expect(JSON.stringify(status)).not.toContain("rec_private");
  });

  it("groups duplicate, superseded, and revised records under their current record", () => {
    const current = record({
      id: "rec_current",
      state: "canonical",
      updated_at: "2026-07-24T04:00:00.000Z",
      links: [
        {
          record_id: "rec_superseded",
          link_type: "supersedes",
          created_at: "2026-07-24T04:00:00.000Z"
        },
        {
          record_id: "rec_revised",
          link_type: "revises",
          created_at: "2026-07-24T04:00:00.000Z"
        }
      ]
    });
    const superseded = record({ id: "rec_superseded", updated_at: "2026-07-24T01:00:00.000Z" });
    const revised = record({ id: "rec_revised", updated_at: "2026-07-24T02:00:00.000Z" });
    const duplicate = record({
      id: "rec_duplicate",
      updated_at: "2026-07-24T03:00:00.000Z",
      links: [
        {
          record_id: current.id,
          link_type: "duplicate_of",
          reason: "Manually confirmed equivalent",
          created_at: "2026-07-24T04:00:00.000Z"
        }
      ]
    });
    const foreignCurrent = record({
      id: "rec_foreign_current",
      project_id: "project-b",
      links: [
        {
          record_id: "rec_foreign_old",
          link_type: "supersedes",
          created_at: "2026-07-24T04:00:00.000Z"
        }
      ]
    });
    const foreignOld = record({ id: "rec_foreign_old", project_id: "project-b" });
    const archivedOld = record({
      id: "rec_archived_old",
      state: "archived",
      visibility: "archived"
    });
    const archivedReplacement = record({
      id: "rec_archived_replacement",
      links: [
        {
          record_id: archivedOld.id,
          link_type: "supersedes",
          created_at: "2026-07-24T04:00:00.000Z"
        }
      ]
    });

    const status = buildDashboardMemoryStatus(
      [superseded, current, revised, duplicate, foreignCurrent, foreignOld, archivedOld, archivedReplacement],
      "project-a"
    );

    expect(Object.keys(status.logical_hidden_by_record_id).sort()).toEqual([
      "rec_duplicate",
      "rec_revised",
      "rec_superseded"
    ]);
    expect(ids(status.logical_active_records)).toEqual(["rec_current", "rec_archived_replacement"]);
    expect(status.organization_groups).toHaveLength(1);
    expect(status.organization_groups[0]?.current_record).toBe(current);
    expect(status.organization_groups[0]?.active_record_id).toBe(current.id);
    expect(status.organization_groups[0]?.older_records.map((item) => [item.record.id, item.relationship])).toEqual([
      ["rec_duplicate", "duplicate_of"],
      ["rec_revised", "revises"],
      ["rec_superseded", "supersedes"]
    ]);
    expect(JSON.stringify(status.organization_groups)).not.toContain("rec_foreign");
    expect(JSON.stringify(status.organization_groups)).not.toContain("rec_archived_old");
  });

  it("uses store scope when no project id is supplied", () => {
    const projectA = record({ id: "rec_project_a" });
    const projectB = record({ id: "rec_project_b", project_id: "project-b" });
    const global = record({ id: "rec_global", scope: "global" });

    const status = buildDashboardMemoryStatus([projectA, projectB, global]);

    expect(ids(status.scoped_records)).toEqual(["rec_project_a", "rec_project_b", "rec_global"]);
  });
});
