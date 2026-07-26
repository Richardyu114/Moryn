import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("Engine memory maintenance shadow", () => {
  it("projects exact duplicate reduction without appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const input = {
        kind: "memory" as const,
        type: "decision",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        content: { text: "Moryn maintenance must make the current set smaller." },
        state: "canonical" as const,
        confirmed: true,
        source: { client: "user" }
      };
      await engine.write(input);
      await engine.write({ ...input, source: { client: "codex" } });
      const before = await readEvents(storePath);

      const report = await engine.memoryMaintenanceShadow({ project_id: "moryn" });
      const after = await readEvents(storePath);

      expect(report).toMatchObject({
        read_only: true,
        projection: {
          before: { current_records: 2 },
          guaranteed_after: { current_records: 1 },
          guaranteed_reduction: { current_records: 1, strict_decrease: true }
        },
        growth: {
          policy: "strictly_decreasing_current_set",
          monotonic_non_growth: true,
          current_record_delta: -1,
          status: "guaranteed_decrease_available"
        }
      });
      expect(after).toEqual(before);
    });
  });

  it("returns structured range errors for unsafe candidate settings", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await expect(engine.memoryMaintenanceShadow({ minimum_token_overlap: 2 })).rejects.toMatchObject({
        name: "ReadArgumentError",
        recovery_hint: {
          operation_contract: "operations_by_id.memory_maintenance_shadow",
          rejected_argument: { argument: "minimum_token_overlap", value: 2 }
        }
      });
    });
  });
});
