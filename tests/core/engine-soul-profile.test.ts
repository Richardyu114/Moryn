import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const occurredAt = "2026-07-20T00:00:00.000Z";
const approvedAt = "2026-07-20T00:01:00.000Z";
const source = { client: "user", device_id: "device-a" };

async function profile(storePath: string, subject: { kind: "user" | "agent"; subject_id: string }, text: string) {
  const draft = await createSoulProfileDraft(storePath, {
    subject,
    clauses: [
      {
        clause_key: subject.kind === "user" ? "publishing" : "persona",
        category: subject.kind === "user" ? "boundary" : "identity",
        text,
        distribution: "personal_sync"
      }
    ],
    source,
    occurred_at: occurredAt
  });
  return (
    await approveSoulProfileDraft(storePath, {
      revision_id: draft.revision.revision_id,
      confirmed: true,
      source,
      occurred_at: approvedAt
    })
  ).revision;
}

describe("Engine Effective Soul", () => {
  it("compiles approved user and Agent profiles into the boot contract", async () => {
    await withInitializedTempStore(async (storePath) => {
      const user = await profile(
        storePath,
        { kind: "user", subject_id: "primary" },
        "Never publish without explicit approval."
      );
      const agent = await profile(
        storePath,
        { kind: "agent", subject_id: "moryn" },
        "Act as the same careful release partner."
      );

      const engine = createEngine({ storePath });
      const boot = await engine.boot({ project_id: "moryn" });
      expect(boot.profile.effective_soul).toMatchObject({ status: "ready", deliverable: true });
      expect(boot.profile.effective_soul.clauses.map((clause) => clause.text)).toEqual([
        "Never publish without explicit approval.",
        "Act as the same careful release partner."
      ]);
      expect(boot.profile.effective_soul.selected_revisions).toHaveLength(2);
      expect(boot.profile.soul).toEqual([]);
      expect(boot.profile.soul_profile_status.personal_sync_revision_ids).toEqual(
        expect.arrayContaining([user.revision_id, agent.revision_id])
      );
      expect(boot.profile.soul_profile_status.personal_sync_revision_ids).toHaveLength(4);
      expect(boot.selection_sources.effective_soul).toBe("profile.effective_soul");
      expect(JSON.stringify(boot.retrieval)).not.toContain("Never publish without explicit approval.");

      const normalRecall = await engine.recall({
        project_id: "moryn",
        kinds: ["soul"],
        query: "careful release partner"
      });
      expect(normalRecall.results).toEqual([]);

      const explicitAudit = await engine.recall({ project_id: "moryn", types: ["profile_revision"] });
      expect(explicitAudit.results).toHaveLength(4);
    });
  });

  it("returns an explicit blocked contract when a profile binding is ambiguous", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await profile(storePath, { kind: "agent", subject_id: "first" }, "First persona.");
      await profile(storePath, { kind: "agent", subject_id: "second" }, "Second persona.");

      const engine = createEngine({ storePath });
      const blocked = await engine.boot({ project_id: "moryn" });
      expect(blocked.profile.effective_soul).toMatchObject({ status: "blocked", deliverable: false });
      expect(blocked.profile.effective_soul.conflicts).toContainEqual(
        expect.objectContaining({ kind: "ambiguous_profile_binding", profile_id: "unbound:agent" })
      );

      const bound = await engine.boot({ project_id: "moryn", agent_profile_id: first.profile_id });
      expect(bound.profile.effective_soul).toMatchObject({ status: "ready", deliverable: true });
      expect(bound.profile.effective_soul.clauses.map((clause) => clause.text)).toEqual(["First persona."]);
    });
  });

  it("validates Soul budget and profile binding inputs before reading", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await expect(engine.boot({ soul_token_budget: 0 })).rejects.toThrow("soul_token_budget");
      await expect(engine.boot({ agent_profile_id: "" })).rejects.toThrow("agent_profile_id");
    });
  });
});
