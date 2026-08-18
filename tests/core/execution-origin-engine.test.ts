import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("engine execution origin boundaries", () => {
  it("keeps synchronized records and events tied to their source device across read APIs", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-08-18T00:00:00.000Z",
        id: (prefix) => `${prefix}_remote_origin`
      });
      const written = await engine.write({
        kind: "memory",
        type: "workspace_path",
        scope: "project",
        project_id: "moryn",
        content: { text: "Build from /home/machine-a/moryn." },
        state: "canonical",
        source: { client: "codex", device_id: "device-a" }
      });

      const recalled = await engine.recall({ record_ids: [written.record.id] });
      expect(recalled.origin_context.current_device.device_id).toBe("device_test");
      expect(recalled.results[0]?.origin).toMatchObject({
        lineage: "remote_device_only",
        source_device_ids: ["device-a"],
        path_resolution: "require_explicit_device_or_workspace_mapping"
      });
      expect(recalled.results_by_id[written.record.id]?.origin).toEqual(recalled.results[0]?.origin);

      const timeline = await engine.timeline({ record_id: written.record.id, before: 1, after: 1 });
      expect(timeline.items[0]?.origin).toMatchObject({
        source_device_id: "device-a",
        relation_to_current_device: "other_device",
        occurrence: "source_device_only"
      });

      const boot = await engine.boot({ project_id: "moryn", current_task: "build moryn" });
      expect(boot.origin_context.records_by_id[written.record.id]).toMatchObject({
        lineage: "remote_device_only"
      });

      const recent = await engine.listRecent({ project_id: "moryn", limit: 5 });
      expect(recent.origin_context.records_by_id[written.record.id]).toMatchObject({
        path_resolution: "require_explicit_device_or_workspace_mapping"
      });

      const refresh = await engine.refresh({ project_id: "moryn", limit: 5 });
      expect(refresh.changes_by_record_id[written.record.id]?.origin).toMatchObject({
        lineage: "remote_device_only"
      });
    });
  });
});
