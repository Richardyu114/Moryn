import { describe, expect, it } from "vitest";
import { SYNC_RESULT_SELECTION_SOURCES, SYNC_STATUS_SELECTION_SOURCES, version } from "../src/index.js";

describe("package smoke test", () => {
  it("exports a version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports sync selection source contracts from the package entrypoint", () => {
    expect(SYNC_STATUS_SELECTION_SOURCES.configured).toBe("configured");
    expect(SYNC_RESULT_SELECTION_SOURCES.pushed).toBe("pushed");
  });
});
