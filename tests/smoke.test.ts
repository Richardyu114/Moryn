import { describe, expect, it } from "vitest";
import {
  BOOT_SELECTION_SOURCES,
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_INIT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  REBUILD_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  OPERATION_CONTRACTS_SELECTION_SOURCES,
  SELECTION_SOURCE_CONTRACTS,
  SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES,
  STORE_INIT_SELECTION_SOURCES,
  SYNC_RESULT_SELECTION_SOURCES,
  SYNC_STATUS_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES,
  getOperationContracts,
  getSelectionSourceContracts,
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

  it("exports lifecycle and recovery selection source contracts from the package entrypoint", () => {
    expect(NEXT_ACTION_SELECTION_SOURCES.error_next_action).toBe("error.next_action");
    expect(NEXT_ACTION_SELECTION_SOURCES.error_argument).toBe("error.next_action.arguments_by_name.<argument>");
    expect(NEXT_ACTION_SELECTION_SOURCES.warning_argument).toBe("warning.next_action.arguments_by_name.<argument>");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action).toBe("next.actions_by_id.<action>");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.ordered_action).toBe("next.actions[]");
    expect(GUIDE_SELECTION_SOURCES.guardrail).toBe("guardrails_by_id.<guardrail_id>");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.step).toBe("lifecycle_by_step.<step>.step");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.workflow_phase).toBe("workflow.phases_by_name.start_or_resume");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action).toBe("next.actions_by_project_id.<project_id>");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.lifecycle_action).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action");
    expect(DOCTOR_SELECTION_SOURCES.blocking_check).toBe("readiness.blocking_checks_by_name.<check_name>");
  });

  it("exports grouped selection source contracts from the package entrypoint", () => {
    expect(SELECTION_SOURCE_CONTRACTS.setup.store_init).toBe(STORE_INIT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.core.boot).toBe(BOOT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.core.project_list_next_action).toBe(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.sync.result).toBe(SYNC_RESULT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.lifecycle.guide).toBe(GUIDE_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.lifecycle.handoff).toBe(HANDOFF_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.recovery.next_action).toBe(NEXT_ACTION_SELECTION_SOURCES);
  });

  it("exports a self-describing selection source contract response", () => {
    const response = getSelectionSourceContracts();

    expect(SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES).toEqual({
      contracts: "contracts",
      group: "contracts.<group>",
      contract: "contracts.<group>.<contract>",
      field: "contracts.<group>.<contract>.<field>"
    });
    expect(response.contracts).toBe(SELECTION_SOURCE_CONTRACTS);
    expect(response.selection_sources).toBe(SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES);
  });

  it("exports self-describing operation contracts from the package entrypoint", () => {
    const response = getOperationContracts();

    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.operation).toBe("operations_by_id.<operation>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.argument).toBe("operations_by_id.<operation>.arguments_by_name.<argument>");
    expect(response.recommended_entrypoint).toBe("agent_enter");
    expect(response.selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_id.agent_enter.interfaces.cli.command).toBe("moryn agent enter");
    expect(response.operations_by_id.agent_enter.interfaces.mcp.tool).toBe("agent_enter");
    expect(response.operations_by_id.agent_enter.arguments_by_name.pull).toMatchObject({
      type: "boolean",
      required: false,
      default: true,
      cli: { negative_flag: "--no-pull" },
      mcp: { argument: "pull" }
    });
    expect(response.operations_by_id.agent_finish.required_fields).toEqual(["summary"]);
    expect(response.operations_by_id.agent_finish.required_fields_by_name.summary).toMatchObject({
      argument_path: "summary",
      placeholder: "<summary>"
    });
    expect(response.operations_by_id.agent_finish.argument_sources).toEqual({
      summary: "user_input.summary"
    });
    expect(response.operations_by_id.write.required_fields).toEqual(["kind", "type", "scope", "text_or_content"]);
    expect(response.operations_by_id.write.arguments_by_name.kind).toMatchObject({
      type: "string",
      required: true,
      cli: { flag: "--kind" },
      mcp: { argument: "kind" },
      allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
    });
    expect(response.operations_by_id.write.arguments_by_name.content).toMatchObject({
      type: "object",
      required: false,
      cli: { flag: "--content-json" },
      mcp: { argument: "content" },
      alternatives: ["text"]
    });
    expect(response.operations_by_id.write.arguments_by_name.derived_from).toMatchObject({
      type: "string[]",
      required: false,
      cli: { flag: "--derived-from", repeatable: true },
      mcp: { argument: "provenance", path: "provenance.derived_from" }
    });
    expect(response.operations_by_id.write.required_fields_by_name.kind.allowed_values).toEqual([
      "memory", "skill", "soul", "session_summary", "agent_note"
    ]);
    expect(response.operations_by_id.write.required_fields_by_name.scope.allowed_values).toEqual([
      "global", "project", "topic", "session", "artifact"
    ]);
    expect(response.operations_by_id.write.required_fields_by_name.text_or_content).toMatchObject({
      argument_path: "text|content",
      alternatives: ["text", "content"]
    });
    expect(response.operations_by_id.promote.required_fields_by_name.target_state.allowed_values).toEqual([
      "raw", "candidate", "canonical", "archived", "quarantined"
    ]);
    expect(response.operations_by_id.project_init.required_fields_by_name.sync_mode.allowed_values).toEqual([
      "manual", "session", "interval"
    ]);
    expect(response.operations_by_id.recall.arguments_by_name.kinds).toMatchObject({
      type: "string[]",
      required: false,
      cli: { flag: "--kind", repeatable: true },
      mcp: { argument: "kinds" },
      allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
    });
    expect(response.operations_by_id.recall.arguments_by_name.limit).toMatchObject({
      type: "number",
      required: false,
      default: 10,
      cli: { flag: "--limit", default: 10 },
      mcp: { argument: "limit" }
    });
    expect(response.operations_by_id.selection_source_contracts.interfaces.cli.command).toBe("moryn contracts selection-sources");
    expect(response.operations_by_id.operation_contracts.interfaces.mcp.tool).toBe("operation_contracts");
    expect(response.operations_by_category.lifecycle.agent_enter).toBe(response.operations_by_id.agent_enter);
  });
});
