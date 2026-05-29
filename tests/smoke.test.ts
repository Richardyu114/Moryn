import { describe, expect, it } from "vitest";
import {
  BOOT_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  PROJECT_INIT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  REBUILD_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  STORE_INIT_SELECTION_SOURCES,
  SYNC_RESULT_SELECTION_SOURCES,
  SYNC_STATUS_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES,
  version
} from "../src/index.js";

describe("package smoke test", () => {
  it("exports a version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports sync selection source contracts from the package entrypoint", () => {
    expect(SYNC_STATUS_SELECTION_SOURCES.configured).toBe("configured");
    expect(SYNC_RESULT_SELECTION_SOURCES.pushed).toBe("pushed");
  });

  it("exports core response selection source contracts from the package entrypoint", () => {
    expect(STORE_INIT_SELECTION_SOURCES.config_file).toBe("artifacts.config");
    expect(PROJECT_INIT_SELECTION_SOURCES.project_id).toBe("config.project_id");
    expect(REBUILD_SELECTION_SOURCES.recall_index).toBe("artifacts.indexes.recall");
    expect(WRITE_SELECTION_SOURCES.record_id).toBe("record.id");
    expect(RECALL_SELECTION_SOURCES.result).toBe("results_by_id.<record_id>");
    expect(BOOT_SELECTION_SOURCES.skill).toBe("skills_by_id.<record_id>");
    expect(REFRESH_SELECTION_SOURCES.next_action).toBe("changes_by_record_id.<record_id>.next_action");
    expect(LIST_RECENT_SELECTION_SOURCES.record).toBe("records_by_id.<record_id>");
    expect(PROJECT_LIST_SELECTION_SOURCES.project).toBe("projects_by_id.<project_id>");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.next_action).toBe("project_list.projects_by_id.<project_id>.next");
    expect(MUTATION_EVENT_SELECTION_SOURCES.event_id).toBe("event.event_id");
    expect(LINK_EVENT_SELECTION_SOURCES.linked_record_id).toBe("event.linked_record_id");
    expect(SENSITIVE_REVISE_SELECTION_SOURCES.quarantine_event_id).toBe("quarantine_event.event_id");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.ordered_next_action).toBe("refresh.changes[].next_action");
  });
});
