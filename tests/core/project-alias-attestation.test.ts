import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import {
  activeProjectAliasAttestations,
  projectAliasAttestationConflict,
  projectAliasAttestationIdentity,
  recordProjectAliasAttestation
} from "../../src/core/project-alias-attestation.js";
import { replayEvents } from "../../src/core/replay.js";
import { readEvents } from "../../src/core/store.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("project alias attestation", () => {
  it("uses unique event identities for the same directional approval on different devices", async () => {
    await withTempStore(async (firstStore) => {
      await withTempStore(async (secondStore) => {
        await initializeStore(firstStore, { id: () => "device-a" });
        await initializeStore(secondStore, { id: () => "device-b" });

        const first = await recordProjectAliasAttestation(firstStore, {
          from_project_id: "legacy-project",
          to_project_id: "canonical-project",
          confirmed_at: "2026-07-31T00:00:00.000Z",
          source: { client: "dashboard", session_id: "approval-a" }
        });
        const second = await recordProjectAliasAttestation(secondStore, {
          from_project_id: "legacy-project",
          to_project_id: "canonical-project",
          confirmed_at: "2026-07-31T00:01:00.000Z",
          source: { client: "dashboard", session_id: "approval-b" }
        });

        expect(first.record.id).toBe(second.record.id);
        expect(first.record.id).toBe(projectAliasAttestationIdentity("legacy-project", "canonical-project").record_id);
        expect(first.event.event_id).not.toBe(second.event.event_id);
        expect(first.event.event_id).toMatch(/^evt_project_alias_[a-f0-9]{32}$/);
        expect(second.event.event_id).toMatch(/^evt_project_alias_[a-f0-9]{32}$/);
        expect((await readEvents(firstStore))[0]?.source.device_id).toBe("device-a");
        expect((await readEvents(secondStore))[0]?.source.device_id).toBe("device-b");

        const repeated = await recordProjectAliasAttestation(firstStore, {
          from_project_id: "legacy-project",
          to_project_id: "canonical-project",
          confirmed_at: "2026-07-31T00:02:00.000Z",
          source: { client: "dashboard", session_id: "approval-a-retry" }
        });
        expect(repeated).toMatchObject({ created: false, record: { id: first.record.id } });
        expect(repeated.event.event_id).toBe(first.event.event_id);
        expect(await readEvents(firstStore)).toHaveLength(1);
      });
    });
  });

  it("fails closed when synchronized attestations map one source to different targets", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { id: () => "device-test" });
      await recordProjectAliasAttestation(storePath, {
        from_project_id: "legacy-project",
        to_project_id: "canonical-a",
        confirmed_at: "2026-07-31T00:00:00.000Z",
        source: { client: "dashboard", session_id: "approval-a" }
      });
      await recordProjectAliasAttestation(storePath, {
        from_project_id: "legacy-project",
        to_project_id: "canonical-b",
        confirmed_at: "2026-07-31T00:01:00.000Z",
        source: { client: "dashboard", session_id: "approval-b" }
      });

      const records = [...replayEvents(await readEvents(storePath)).values()];
      expect(activeProjectAliasAttestations(records).size).toBe(0);
      expect(projectAliasAttestationConflict(records, "legacy-project", "canonical-a")).toEqual({
        code: "source_already_mapped",
        conflicting_directions: ["legacy-project -> canonical-b"]
      });
    });
  });

  it("allows lifecycle revocation but blocks generic edits to alias control records", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const attestation = await recordProjectAliasAttestation(storePath, {
        from_project_id: "legacy-project",
        to_project_id: "canonical-project",
        confirmed_at: "2026-07-31T00:00:00.000Z",
        source: { client: "dashboard", session_id: "approval" }
      });
      const engine = createEngine({ storePath });
      const other = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "canonical-project",
        content: { text: "Ordinary note.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      await expect(
        engine.revise({
          record_id: attestation.record.id,
          patch: { "content.from_project_id": "other-project" },
          reason: "Attempt to rewrite control state"
        })
      ).rejects.toThrow("project alias attestation records cannot be revised");
      await expect(
        engine.link({
          record_id: attestation.record.id,
          linked_record_id: other.record.id,
          link_type: "related"
        })
      ).rejects.toThrow("project alias attestation records cannot be linked");
      await expect(
        engine.promote({
          record_id: attestation.record.id,
          target_state: "candidate",
          reason: "Attempt to demote control state"
        })
      ).rejects.toThrow("project alias attestations can only be promoted to canonical");

      await engine.archive({ record_id: attestation.record.id, reason: "Revoke this alias" });
      await expect(
        engine.promote({
          record_id: attestation.record.id,
          target_state: "canonical",
          reason: "Reapprove this alias",
          confirmed: true,
          source: { client: "user" }
        })
      ).resolves.toBeDefined();
    });
  });
});
