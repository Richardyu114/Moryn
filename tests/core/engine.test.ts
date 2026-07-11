import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const WRITE_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  warning_next_action: "warning.next_action"
};
const MUTATION_EVENT_SELECTION_SOURCES = {
  event: "event",
  event_id: "event.event_id",
  record_id: "event.record_id"
};
const LINK_EVENT_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  linked_record_id: "event.linked_record_id"
};
const SENSITIVE_REVISE_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  quarantine_event: "quarantine_event",
  quarantine_event_id: "quarantine_event.event_id"
};
const MEMORY_DOCTOR_SELECTION_SOURCES = {
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
};
const DOGFOOD_REPORT_SELECTION_SOURCES = {
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_id.<event_id>",
  event_id: "events_by_id.<event_id>.event_id"
};
const HEALTH_CHECK_SELECTION_SOURCES = {
  check: "checks_by_id.<check_id>",
  check_id: "checks_by_id.<check_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  stat: "stats.<field>",
  setup_readiness: "setup_readiness",
  activation_status: "activation_status"
};
const CAPTURE_POLICY_SELECTION_SOURCES = {
  decision: "decisions_by_record_id.<record_id>",
  decision_record_id: "decisions_by_record_id.<record_id>.record_id",
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_id.<event_id>",
  event_id: "events_by_id.<event_id>.event_id"
};
const MEMORY_LIFECYCLE_SELECTION_SOURCES = {
  assessment: "assessments_by_record_id.<record_id>",
  assessment_record_id: "assessments_by_record_id.<record_id>.record_id",
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
};
const PROJECT_MIGRATE_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_record_id.<record_id>",
  event_id: "events_by_record_id.<record_id>.event_id"
};

function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(workflow: TWorkflow) {
  return {
    ...workflow,
    phases_by_name: Object.fromEntries(workflow.phases.map((phase) => [phase.phase, phase]))
  };
}

function expectNextActionInterfaces(action: {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  interfaces?: {
    cli?: { command?: string; command_line?: string; argv?: string[]; executable?: string; args?: string[]; exec_file?: { executable?: string; args?: string[] } };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
}) {
  expect(action.interfaces?.cli).toEqual({
    command: action.command,
    command_line: expect.any(String),
    argv: expect.any(Array),
    executable: expect.any(String),
    args: expect.any(Array),
    exec_file: {
      executable: expect.any(String),
      args: expect.any(Array)
    },
    placeholders: expect.any(Array),
    has_placeholders: expect.any(Boolean)
  });
  expect(action.interfaces?.mcp).toEqual({
    tool: action.tool,
    arguments: action.arguments
  });
}

function expectNextActionWorkflow(action: {
  recommended_action: string;
  tool: string;
  required_when?: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
      replace_arguments?: Record<string, string>;
    }>;
  };
}) {
  expect(action.required_when).toEqual(expect.any(String));
  expect(action.required_when).not.toHaveLength(0);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["error.next_action", "warning.next_action"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "next_action",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectCandidatePromoteWorkflow(action: {
  required_when?: string;
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
      replace_arguments?: Record<string, string>;
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["error.next_action", "warning.next_action", "write.record.id"],
    phases: [
      {
        phase: "ask_user_then_promote_candidate",
        order: 1,
        action_source: "write.record.id",
        tool: "promote",
        required_when: action.required_when,
        required_fields: ["record_id"],
        replace_arguments: { record_id: "write.record.id" }
      }
    ]
  }));
}

function expectActionSafety(action: {
  safe_to_run: boolean;
  required_fields: string[];
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
}) {
  expect(action.safety).toMatchObject({
    safe_to_auto_run: action.safe_to_run,
    requires_authored_input: action.required_fields.length > 0
  });
  expect(action.safety?.reasons).toEqual(expect.any(Array));
  expect(action.safety?.reasons?.length).toBeGreaterThan(0);
}

function expectActionExecution(action: {
  safe_to_run: boolean;
  required_fields: string[];
  required_fields_by_name: Record<string, { argument_path?: string }>;
  selection_sources?: Record<string, string>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  const expectedArgumentPaths = action.required_fields.map((field) => action.required_fields_by_name[field]?.argument_path ?? field);
  const expectedSplitArgumentPaths = expectedArgumentPaths.map((argumentPath) =>
    argumentPath.split("|").map((path) => path.trim()).filter(Boolean)
  );
  expect(action.execution?.missing_required_fields).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.field)).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.execution?.required_inputs?.map((input) => input.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(Object.keys(action.execution?.required_inputs_by_field ?? {})).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.field)).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.mcp_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.mcp_targets)
  );
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.cli_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.cli_targets)
  );
  const expectedRequiredInputSelectionSources = Object.fromEntries(
    Object.entries(action.selection_sources ?? {}).filter(([key]) => key.includes("required_input"))
  );
  if (action.required_fields.length > 0 && Object.keys(expectedRequiredInputSelectionSources).length > 0) {
    expect(action.execution?.required_inputs?.map((input) => input.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
    expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
  }
  expect(action.execution?.requires_user_confirmation).toBe(Boolean(action.safety?.requires_user_confirmation));
  if (action.required_fields.length > 0) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: [
        "required_fields",
        ...(action.safety?.requires_user_confirmation ? ["user_confirmation"] : [])
      ]
    });
  } else if (action.safety?.requires_user_confirmation) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "confirm_with_user",
      blocked_by: ["user_confirmation"]
    });
  } else {
    expect(action.execution).toMatchObject({
      ready_to_run: action.safe_to_run,
      next_step: action.safe_to_run ? "run" : "do_not_auto_run",
      blocked_by: action.safe_to_run ? [] : ["unsafe_action"]
    });
  }
}

function expectRefreshChangeRecallAction(action: {
  action_source?: string;
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  arguments_by_name?: Record<string, unknown>;
  argument_sources?: Record<string, string>;
  selection_sources?: Record<string, string>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  interfaces?: {
    cli?: { command?: string };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
  execution?: Record<string, unknown>;
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}, recordId: string, projectId?: string) {
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
    action_source: `refresh.changes_by_record_id.${recordId}.next_action`,
    tool: "recall",
    safe_to_run: true,
    required_when: "After refresh reports this change and the agent needs the full record content.",
    required_fields: [],
    command: projectId
      ? `moryn recall --record-id ${recordId} --project-id ${projectId}`
      : `moryn recall --record-id ${recordId}`,
    arguments: {
      record_ids: [recordId],
      ...(projectId ? { project_id: projectId } : {})
    },
    argument_sources: {
      record_ids: "refresh.changes_by_record_id.<record_id>.record_id"
    },
    selection_sources: {
      change: "refresh.changes_by_record_id.<record_id>",
      record_id: "refresh.changes_by_record_id.<record_id>.record_id",
      next_action: "refresh.changes_by_record_id.<record_id>.next_action",
      ordered_next_action: "refresh.changes[].next_action",
      cli_executable: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.executable",
      cli_argv: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
      cli_args: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
      cli_exec_file: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
      cli_placeholder: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
      cli_command_line: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
      ordered_cli_executable: "refresh.changes[].next_action.interfaces.cli.executable",
      ordered_cli_argv: "refresh.changes[].next_action.interfaces.cli.argv[]",
      ordered_cli_args: "refresh.changes[].next_action.interfaces.cli.args[]",
      ordered_cli_exec_file: "refresh.changes[].next_action.interfaces.cli.exec_file",
      ordered_cli_placeholder: "refresh.changes[].next_action.interfaces.cli.placeholders[]",
      ordered_cli_command_line: "refresh.changes[].next_action.interfaces.cli.command_line",
      argument: "refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
      ordered_argument: "refresh.changes[].next_action.arguments_by_name.<argument>",
      required_field: "refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
      ordered_required_field: "refresh.changes[].next_action.required_fields_by_name.<field>",
      required_input: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
      ordered_required_input: "refresh.changes[].next_action.execution.required_inputs_by_field.<field>",
      required_input_argument_path: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
      ordered_required_input_argument_path: "refresh.changes[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
      argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
      ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
    }
  });
  expectNextActionInterfaces(action);
  expect(action.arguments_by_name?.record_ids).toMatchObject({
    name: "record_ids",
    type: "string[]",
    required: false,
    cli: { flag: "--record-id", repeatable: true },
    mcp: { argument: "record_ids" }
  });
  expect(action.arguments_by_name?.project_id).toMatchObject({
    name: "project_id",
    type: "string",
    required: false,
    cli: { flag: "--project-id" },
    mcp: { argument: "project_id" }
  });
  expectActionSafety(action);
  expectActionExecution(action);
  expect(action.safety?.reasons).toEqual(["safe_read_or_status_check"]);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["refresh.changes_by_record_id.<record_id>.next_action", "refresh.changes[].next_action"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "refresh.changes_by_record_id.<record_id>.next_action",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

describe("core engine", () => {
  it("consolidates exact duplicates into deterministic idempotent links", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-07-11T00:00:0${tick++}.000Z`,
        id: (prefix) => `${prefix}_${++nextId}`
      });
      const base = {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["architecture"],
        content: { text: "Use append-only events" },
        source: { client: "codex" }
      } as const;
      const candidate = await engine.write({ ...base, state: "candidate", priority: "high" });
      const canonical = await engine.write({ ...base, state: "canonical", priority: "low", confirmed: true, source: { client: "user" } });
      const raw = await engine.write({ ...base, state: "raw", priority: "high" });

      const first = await engine.consolidateExactDuplicates({ project_id: "moryn" });
      const second = await engine.consolidateExactDuplicates({ project_id: "moryn" });
      const events = await readEvents(storePath);
      const duplicateLinks = events.filter((event) => event.op === "link_records" && event.link_type === "duplicate_of");

      expect(first).toMatchObject({
        groups_found: 1,
        links_created: 2,
        groups: [{ target_record_id: canonical.record.id, duplicate_record_ids: [candidate.record.id, raw.record.id].sort() }]
      });
      expect(second).toMatchObject({ groups_found: 1, links_created: 0, links_existing: 2 });
      expect(duplicateLinks).toHaveLength(2);
      expect(duplicateLinks.map((event) => event.op === "link_records" ? [event.record_id, event.linked_record_id] : [])).toEqual([
        [candidate.record.id, canonical.record.id],
        [raw.record.id, canonical.record.id]
      ].sort(([left], [right]) => left.localeCompare(right)));
    });
  });

  it("does not expose or consolidate private duplicates by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private preference" },
        source: { client: "codex" }
      } as const;
      await engine.write(base);
      await engine.write(base);

      expect(await engine.consolidateExactDuplicates({ project_id: "moryn" })).toMatchObject({ groups_found: 0, links_created: 0 });
      expect(await engine.consolidateExactDuplicates({ project_id: "moryn", include_private: true })).toMatchObject({ groups_found: 1, links_created: 1 });
    });
  });

  it("consolidates exact duplicates once across concurrent agents", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const writer = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Pull on enter and push on finish" },
        source: { client: "codex" }
      } as const;
      await writer.write(base);
      await writer.write(base);
      const codex = createEngine({ storePath });
      const claude = createEngine({ storePath });

      const results = await Promise.all([
        codex.consolidateExactDuplicates({ project_id: "moryn", source: { client: "codex" } }),
        claude.consolidateExactDuplicates({ project_id: "moryn", source: { client: "claude-code" } })
      ]);
      const duplicateLinks = (await readEvents(storePath)).filter((event) => event.op === "link_records" && event.link_type === "duplicate_of");

      expect(results.reduce((sum, result) => sum + result.links_created, 0)).toBe(1);
      expect(duplicateLinks).toHaveLength(1);
    });
  });

  it("adds checkpoint recovery to boot only when an agent session id is provided", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const source = { client: "codex", session_id: "boot-session", device_id: "device-test" };
      const first = await engine.checkpoint({
        project_id: "moryn", source, occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { session_id: "boot-session", checkpoint_id: "one", current_task: "Recover boot", progress: ["public"], decisions: [], changed_facts: [], blockers: [], next_steps: ["continue"], files: [], candidate_memories: [], candidate_skills: [], learnings: [] }
      });
      await engine.checkpoint({
        project_id: "moryn", source, occurred_at: "2026-07-11T00:01:00.000Z", tags: ["private"],
        delta: { session_id: "boot-session", checkpoint_id: "two", current_task: "Secret task", progress: ["secret"], decisions: [], changed_facts: [], blockers: [], next_steps: [], files: [], candidate_memories: [], candidate_skills: [], learnings: [] }
      });

      const withoutSession = await engine.boot({ project_id: "moryn" });
      expect(withoutSession).not.toHaveProperty("active_checkpoint");
      expect(withoutSession).not.toHaveProperty("checkpoint_recovery_pack");
      const boot = await engine.boot({ project_id: "moryn", agent_session_id: "boot-session" });
      expect(boot.active_checkpoint).toEqual(first.record);
      expect(boot.checkpoint_recovery_pack).toMatchObject({ available: true, checkpoint_count: 1, source_record_ids: [first.record.id], progress: ["public"] });
      expect(boot.selection_sources).toMatchObject({ active_checkpoint: "active_checkpoint", checkpoint_recovery_pack: "checkpoint_recovery_pack" });
      const privateBoot = await engine.boot({ project_id: "moryn", agent_session_id: "boot-session", include_private: true });
      expect(privateBoot.active_checkpoint.content.checkpoint.checkpoint_id).toBe("two");
      expect(privateBoot.checkpoint_recovery_pack.progress).toEqual(["public", "secret"]);
    });
  });
  it("reports read-only installation health and review next steps", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-21T00:00:${String(tick++).padStart(2, "0")}.000Z`
      });
      const capture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Codex captured a handoff that needs user review.", format: "text" },
        source: { client: "codex", session_id: "health-check" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private health check detail must stay hidden.", format: "text" },
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.healthCheck({ project_id: "moryn", limit: 20 });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(report).toMatchObject({
        read_only: true,
        version: 1,
        scope: "local_store",
        project_id: "moryn",
        status: "needs_attention",
        summary: {
          status: "needs_attention",
          failing_checks: 0,
          warning_checks: 1
        }
      });
      expect(report.selection_sources).toEqual(HEALTH_CHECK_SELECTION_SOURCES);
      expect(report.stats).toMatchObject({
        visible_records: 1,
        excluded_private_records: 1,
        total_events: beforeEvents.length,
        capture_review_candidates: 1
      });
      expect(report.checks_by_id.store_readable).toMatchObject({ status: "pass", category: "store" });
      expect(report.checks_by_id.event_log_replayable).toMatchObject({ status: "pass", category: "store" });
      expect(report.checks_by_id.project_context).toMatchObject({ status: "pass", category: "project" });
      expect(report.checks_by_id.capture_review_backlog).toMatchObject({
        status: "warning",
        category: "capture",
        record_ids: [capture.record.id]
      });
      expect(report.checks_by_id.mcp_runtime).toMatchObject({
        status: "info",
        category: "runtime",
        label: "MCP runtime freshness",
        summary: "MCP hosts load Moryn when the host process starts."
      });
      expect(report.checks_by_id.mcp_runtime.reason).toContain("restart the MCP host");
      expect(report.suggested_actions_by_id.review_capture_inbox).toMatchObject({
        tool: "dashboard",
        command: "moryn dashboard --serve --project-id moryn",
        safe_to_run: true
      });
      expect(JSON.stringify(report)).not.toContain("Private health check detail");
    });
  });

  it("adds read-only setup readiness checks for host adapters, dashboard, and sync", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const beforeEvents = await readEvents(storePath);

      const report = await engine.healthCheck({
        project_id: "moryn",
        host: "codex",
        sync_remote: "git@github.com:user/moryn-store.git",
        limit: 20
      });

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(report.read_only).toBe(true);
      expect(report.setup_readiness).toMatchObject({
        host: "codex",
        host_adapter: "Codex",
        sync_remote: "git@github.com:user/moryn-store.git",
        dashboard_command: "moryn dashboard --serve --project-id moryn",
        install_command: "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
        context_pack_command: "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex",
        capture_command: "moryn capture session --project-id moryn --sync-remote git@github.com:user/moryn-store.git --agent codex --summary '<summary>'"
      });
      expect(report.checks_by_id.dashboard_access).toMatchObject({
        status: "info",
        category: "runtime",
        label: "Dashboard access",
        summary: "Dashboard can be opened locally for review."
      });
      expect(report.checks_by_id.sync_remote).toMatchObject({
        status: "info",
        category: "sync",
        label: "Sync remote supplied",
        summary: "Sync remote is available for generated lifecycle commands."
      });
      expect(report.checks_by_id.host_adapter).toMatchObject({
        status: "pass",
        category: "host",
        label: "Host adapter",
        summary: "Codex adapter commands are available."
      });
      expect(report.suggested_actions_by_id.open_dashboard).toMatchObject({
        tool: "dashboard",
        command: "moryn dashboard --serve --project-id moryn",
        safe_to_run: true
      });
      expect(report.suggested_actions_by_id.review_install_plan).toMatchObject({
        tool: "install",
        command: "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
        safe_to_run: true
      });
      expect(report.suggested_actions_by_id.run_context_pack).toMatchObject({
        tool: "context_pack",
        command: "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex",
        safe_to_run: true
      });
      expect(report.suggested_actions_by_id.capture_session).toMatchObject({
        tool: "capture_session",
        command: "moryn capture session --project-id moryn --sync-remote git@github.com:user/moryn-store.git --agent codex --summary '<summary>'",
        safe_to_run: false,
        required_fields: ["summary"]
      });
      expect(report.suggested_actions_by_id.configure_sync_remote).toBeUndefined();
    });
  });

  it("does not treat auto-captured low-risk handoffs as Capture Inbox health backlog", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-21T00:01:${String(tick++).padStart(2, "0")}.000Z`
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Codex captured a low-risk handoff for context packs.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "health-auto-capture" }
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.healthCheck({ project_id: "moryn", limit: 20 });

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(report.status).toBe("healthy");
      expect(report.stats.capture_review_candidates).toBe(0);
      expect(report.checks_by_id.capture_review_backlog).toMatchObject({
        status: "pass",
        category: "capture",
        summary: "No active capture candidates need review."
      });
      expect(report.suggested_actions_by_id.review_capture_inbox).toBeUndefined();
    });
  });

  it("reports dogfood friction signals without mutating the store", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:00:${String(tick++).padStart(2, "0")}.000Z`
      });
      const firstCapture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Codex finished Dogfood Report planning.", format: "text" },
        source: { client: "codex", session_id: "codex-1" }
      });
      const duplicateCapture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Codex finished Dogfood Report planning.", format: "text" },
        source: { client: "codex", session_id: "codex-1" }
      });
      const failureNote = await engine.write({
        kind: "agent_note",
        type: "failure",
        scope: "project",
        project_id: "moryn",
        tags: ["dogfood", "timeout"],
        content: { text: "npm test failed: CLI timeout while running release check.", format: "text" },
        source: { client: "codex", session_id: "codex-2" }
      });
      const privateNote = await engine.write({
        kind: "agent_note",
        type: "failure",
        scope: "project",
        project_id: "moryn",
        tags: ["dogfood", "private"],
        content: { text: "Private dogfood failure must not appear by default.", format: "text" },
        source: { client: "codex", session_id: "codex-private" }
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(report).toMatchObject({
        read_only: true,
        project_id: "moryn",
        version: 1,
        scope: "local_store"
      });
      expect(report.selection_sources).toEqual(DOGFOOD_REPORT_SELECTION_SOURCES);
      expect(report.stats).toMatchObject({
        total_records: 3,
        excluded_private_records: 1,
        autocapture_candidates: 2,
        duplicate_text_groups: 1,
        failure_signal_records: 1
      });
      expect(report.findings_by_id.capture_review_backlog).toMatchObject({
        category: "capture_review",
        severity: "warning",
        record_ids: expect.arrayContaining([firstCapture.record.id, duplicateCapture.record.id])
      });
      expect(report.findings_by_id.duplicate_capture_text).toMatchObject({
        category: "duplication",
        severity: "warning",
        record_ids: expect.arrayContaining([firstCapture.record.id, duplicateCapture.record.id])
      });
      expect(report.findings_by_id.failure_signals).toMatchObject({
        category: "friction",
        severity: "warning",
        record_ids: [failureNote.record.id]
      });
      expect(report.suggested_actions_by_id.review_capture_inbox).toMatchObject({
        tool: "dashboard",
        safe_to_run: true,
        command: "moryn dashboard --serve --project-id moryn"
      });
      expect(report.suggested_actions_by_id.inspect_failure_signals).toMatchObject({
        tool: "timeline",
        safe_to_run: true,
        arguments: { record_id: failureNote.record.id, project_id: "moryn", before: 3, after: 3 }
      });
      expect(report.records_by_id[firstCapture.record.id]?.id).toBe(firstCapture.record.id);
      expect(report.records_by_id[privateNote.record.id]).toBeUndefined();
      const failureEvent = beforeEvents.find((event) => event.op === "upsert_record" && event.record.id === failureNote.record.id);
      expect(report.events_by_id).toHaveProperty(failureEvent?.event_id as string);
      expect(JSON.stringify(report)).not.toContain("Private dogfood failure");
    });
  });

  it("does not route low-risk auto-captured handoffs to dogfood capture review backlog", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:01:${String(tick++).padStart(2, "0")}.000Z`
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Codex finished a low-risk handoff for dogfood context.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "dogfood-auto-capture" }
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(report.stats.autocapture_candidates).toBe(0);
      expect(report.findings_by_id.capture_review_backlog).toBeUndefined();
      expect(report.suggested_actions_by_id.review_capture_inbox).toBeUndefined();
    });
  });

  it("does not treat resolved implementation handoffs as active dogfood failure signals", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:02:${String(tick++).padStart(2, "0")}.000Z`
      });

      const resolved = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Fixed the dashboard timeout false-positive. Verification completed: regression tests passed, typecheck passed, build passed, release check passed, and dashboard restarted.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "resolved-timeout" }
      });
      const activeFailure = await engine.write({
        kind: "agent_note",
        type: "failure",
        scope: "project",
        project_id: "moryn",
        tags: ["dogfood", "timeout"],
        content: { text: "Dashboard refresh is blocked by a timeout in the dogfood report.", format: "text" },
        source: { client: "codex", session_id: "active-timeout" }
      });

      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });

      expect(report.stats.failure_signal_records).toBe(1);
      expect(report.findings_by_id.failure_signals).toMatchObject({
        category: "friction",
        record_ids: [activeFailure.record.id]
      });
      expect(report.findings_by_id.failure_signals?.record_ids).not.toContain(resolved.record.id);
    });
  });

  it("does not treat verified added-change handoffs as active dogfood failure signals", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:03:${String(tick++).padStart(2, "0")}.000Z`
      });

      const resolved = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Added regression coverage for project-context error recovery. Verified focused tests, typecheck, full suite, release check, dist dogfood, and lifecycle smoke.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "resolved-regression" }
      });
      const activeFailure = await engine.write({
        kind: "agent_note",
        type: "failure",
        scope: "project",
        project_id: "moryn",
        tags: ["dogfood", "regression"],
        content: { text: "Regression remains blocked in dashboard routing.", format: "text" },
        source: { client: "codex", session_id: "active-regression" }
      });

      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });

      expect(report.stats.failure_signal_records).toBe(1);
      expect(report.findings_by_id.failure_signals?.record_ids).toEqual([activeFailure.record.id]);
      expect(report.findings_by_id.failure_signals?.record_ids).not.toContain(resolved.record.id);
    });
  });

  it("does not treat healthy restarted handoffs as active dogfood failure signals", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:05:${String(tick++).padStart(2, "0")}.000Z`
      });

      const resolved = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "text",
          text: "Aligned capture review backlog semantics. Added shared capture review predicate, regression coverage, docs contract updates, pushed main commit, and restarted dashboard with healthy health_check, zero capture review candidates, zero Capture Inbox items, and no dogfood capture backlog."
        },
        source: { client: "codex", session_id: "healthy-restarted" }
      });
      const activeFailure = await engine.write({
        kind: "agent_note",
        type: "failure",
        scope: "project",
        project_id: "moryn",
        tags: ["dogfood", "blocked"],
        content: { text: "Capture review backlog remains blocked after dashboard restart.", format: "text" },
        source: { client: "codex", session_id: "active-blocked" }
      });

      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });

      expect(report.stats.failure_signal_records).toBe(1);
      expect(report.findings_by_id.failure_signals?.record_ids).toEqual([activeFailure.record.id]);
      expect(report.findings_by_id.failure_signals?.record_ids).not.toContain(resolved.record.id);
    });
  });

  it("keeps canonical memory failure language visible in dogfood signals", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:04:${String(tick++).padStart(2, "0")}.000Z`
      });

      const canonical = await engine.write({
        kind: "memory",
        type: "release_roadmap",
        scope: "project",
        project_id: "moryn",
        state: "canonical",
        tags: ["roadmap"],
        content: {
          format: "text",
          text: "Added release principles. One risk remains blocked until dashboard review noise is reduced."
        },
        source: { client: "codex", session_id: "canonical-risk" }
      });

      const report = await engine.dogfoodReport({ project_id: "moryn", limit: 20 });

      expect(report.stats.failure_signal_records).toBe(1);
      expect(report.findings_by_id.failure_signals?.record_ids).toEqual([canonical.record.id]);
    });
  });

  it("audits autocapture policy decisions without mutating or exposing private records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-20T00:10:${String(tick++).padStart(2, "0")}.000Z`
      });
      const reviewCapture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          text: "Codex finished dashboard approval polish and needs manual review.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "review",
              review_required: true,
              auto_canonical: false,
              rule_ids: ["default_review_for_agent_handoff"],
              reasons: ["default_review_for_agent_handoff"]
            }
          }
        },
        source: { client: "codex", session_id: "policy-review" }
      });
      const autoCapture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          text: "Codex finished low-risk setup polish.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "policy-capture" }
      });
      const smokeArchive = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "policy-archived", "host:codex", "noise:smoke_test_marker"],
        content: {
          text: "Smoke test marker only.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "archive",
              review_required: false,
              auto_canonical: false,
              rule_ids: ["smoke_test_marker"],
              reasons: ["smoke_test_marker"]
            }
          }
        },
        state: "archived",
        confidence: 0.1,
        source: { client: "codex", session_id: "policy-smoke" }
      });
      const duplicateArchive = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "policy-archived", "host:codex", "noise:duplicate_text"],
        content: {
          text: "Codex finished dashboard approval polish.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "archive",
              review_required: false,
              auto_canonical: false,
              rule_ids: ["duplicate_text"],
              reasons: ["duplicate_text"],
              duplicate_of_record_id: reviewCapture.record.id
            }
          }
        },
        state: "archived",
        confidence: 0.1,
        source: { client: "codex", session_id: "policy-duplicate" }
      });
      const otherProjectArchive = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "other-project",
        tags: ["autocapture", "policy-archived", "host:codex", "noise:smoke_test_marker"],
        content: {
          text: "Other project smoke test marker.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "archive",
              review_required: false,
              auto_canonical: false,
              rule_ids: ["smoke_test_marker"],
              reasons: ["smoke_test_marker"]
            }
          }
        },
        state: "archived",
        source: { client: "codex" }
      });
      const privateArchive = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "policy-archived", "host:codex", "noise:smoke_test_marker", "private"],
        content: {
          text: "Private policy archive must stay hidden.",
          format: "json",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "archive",
              review_required: false,
              auto_canonical: false,
              rule_ids: ["smoke_test_marker"],
              reasons: ["smoke_test_marker"]
            }
          }
        },
        state: "archived",
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.capturePolicy({ project_id: "moryn", limit: 20 });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(report).toMatchObject({
        read_only: true,
        version: 1,
        scope: "local_store",
        project_id: "moryn",
        policy: {
          id: "default_autocapture_policy",
          auto_canonical: false,
          canonical_requires_user_action: true
        }
      });
      expect(report.selection_sources).toEqual(CAPTURE_POLICY_SELECTION_SOURCES);
      expect(report.stats).toMatchObject({
        total_autocapture_records: 4,
        excluded_private_records: 1,
        auto_captured_records: 1,
        review_records: 1,
        policy_archived_records: 2,
        captured_by_rule: {
          low_risk_handoff_auto_capture: 1
        },
        archived_by_rule: {
          smoke_test_marker: 1,
          duplicate_text: 1
        }
      });
      expect(report.decisions_by_record_id[reviewCapture.record.id]).toMatchObject({
        record_id: reviewCapture.record.id,
        decision: "review",
        target_state: "candidate",
        review_required: true,
        auto_canonical: false,
        rule_ids: ["default_review_for_agent_handoff"],
        evidence: expect.arrayContaining([
          expect.objectContaining({ source: "record.content.capture.policy" }),
          expect.objectContaining({ source: "record.tags[]" })
        ])
      });
      expect(report.decisions_by_record_id[autoCapture.record.id]).toMatchObject({
        record_id: autoCapture.record.id,
        decision: "capture",
        target_state: "candidate",
        review_required: false,
        auto_canonical: false,
        rule_ids: ["low_risk_handoff_auto_capture"]
      });
      expect(report.decisions_by_record_id[smokeArchive.record.id]).toMatchObject({
        record_id: smokeArchive.record.id,
        decision: "archive",
        target_state: "archived",
        review_required: false,
        auto_canonical: false,
        rule_ids: ["smoke_test_marker"]
      });
      expect(report.decisions_by_record_id[duplicateArchive.record.id]).toMatchObject({
        record_id: duplicateArchive.record.id,
        decision: "archive",
        target_state: "archived",
        duplicate_of_record_id: reviewCapture.record.id,
        rule_ids: ["duplicate_text"]
      });
      expect(report.findings_by_id.review_required).toMatchObject({
        category: "review_queue",
        severity: "info",
        record_ids: [reviewCapture.record.id]
      });
      expect(report.findings_by_id.auto_captured).toMatchObject({
        category: "auto_capture",
        severity: "info",
        record_ids: [autoCapture.record.id]
      });
      expect(report.findings_by_id.policy_archived).toMatchObject({
        category: "policy_archive",
        severity: "info",
        record_ids: expect.arrayContaining([smokeArchive.record.id, duplicateArchive.record.id])
      });
      expect(report.suggested_actions_by_id.review_capture_inbox).toMatchObject({
        tool: "dashboard",
        safe_to_run: true,
        command: "moryn dashboard --serve --project-id moryn"
      });
      expect(report.suggested_actions_by_id[`inspect:${smokeArchive.record.id}`]).toMatchObject({
        tool: "timeline",
        safe_to_run: true,
        arguments: { record_id: smokeArchive.record.id, project_id: "moryn", before: 3, after: 3 }
      });
      expect(report.suggested_actions_by_id[`inspect:${autoCapture.record.id}`]).toMatchObject({
        recommended_action: "inspect_auto_captured_handoff",
        tool: "timeline",
        safe_to_run: true,
        arguments: { record_id: autoCapture.record.id, project_id: "moryn", before: 3, after: 3 }
      });
      expect(report.records_by_id[reviewCapture.record.id]?.id).toBe(reviewCapture.record.id);
      expect(report.records_by_id[otherProjectArchive.record.id]).toBeUndefined();
      expect(report.records_by_id[privateArchive.record.id]).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("Private policy archive");
    });
  });

  it("diagnoses candidate backlog, promotable rules, noise, and project identity splits without mutating records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-19T00:00:${String(tick++).padStart(2, "0")}.000Z`
      });
      const durableRule = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "repository-policy", "local-only-docs"],
        content: { text: "docs/superpowers must remain local-only and never be committed.", format: "text" },
        confidence: 1,
        priority: "high",
        source: { client: "user" }
      });
      const marker = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "e2e"],
        content: { text: "moryn host e2e codex marker completed.", format: "text" },
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "doctor"],
        content: { text: "Memory doctor should stay read-only.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Recent implementation checkpoint.", format: "text" },
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "doctor"],
        content: { text: "Older project id still contains Moryn memories.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const privateRecord = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "private"],
        content: { text: "Private rule should be hidden by default.", format: "text" },
        source: { client: "user" }
      });

      const beforeEvents = await readEvents(storePath);
      const doctor = await engine.memoryDoctor({
        project_id: "repo-e6f0166fd942",
        limit: 20
      });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(doctor.read_only).toBe(true);
      expect(doctor.stats.total_records).toBe(5);
      expect(doctor.stats.excluded_private_records).toBe(1);
      expect(doctor.stats.states).toMatchObject({ candidate: 3, canonical: 2 });
      expect(doctor.stats.projects).toMatchObject({ "repo-e6f0166fd942": 4, moryn: 1 });
      expect(doctor.selection_sources).toEqual(MEMORY_DOCTOR_SELECTION_SOURCES);
      expect(doctor.records_by_id[durableRule.record.id]?.id).toBe(durableRule.record.id);
      expect(doctor.records_by_id[privateRecord.record.id]).toBeUndefined();

      expect(doctor.findings_by_id.candidate_backlog).toMatchObject({
        id: "candidate_backlog",
        category: "backlog",
        severity: "warning"
      });
      expect(doctor.findings_by_id.project_identity_split).toMatchObject({
        id: "project_identity_split",
        category: "project_identity",
        severity: "warning",
        project_id: "repo-e6f0166fd942",
        related_project_ids: ["moryn"]
      });

      const promoteAction = doctor.suggested_actions_by_id[`promote:${durableRule.record.id}`];
      expect(promoteAction).toMatchObject({
        action_id: `promote:${durableRule.record.id}`,
        recommended_action: "promote_candidate",
        tool: "promote",
        command: `moryn promote ${durableRule.record.id} --state canonical --reason 'Memory doctor: confirmed/high-confidence candidate review' --confirm`,
        arguments: {
          record_id: durableRule.record.id,
          target_state: "canonical",
          reason: "Memory doctor: confirmed/high-confidence candidate review",
          confirmed: true
        },
        safe_to_run: false,
        required_fields: []
      });
      expect(promoteAction.interfaces?.mcp).toEqual({
        tool: "promote",
        arguments: {
          record_id: durableRule.record.id,
          target_state: "canonical",
          reason: "Memory doctor: confirmed/high-confidence candidate review",
          confirmed: true
        }
      });

      expect(doctor.suggested_actions_by_id[`archive:${marker.record.id}`]).toMatchObject({
        action_id: `archive:${marker.record.id}`,
        recommended_action: "archive_record",
        tool: "archive",
        command: `moryn archive ${marker.record.id} --reason 'Memory doctor: e2e marker/noise candidate'`,
        arguments: {
          record_id: marker.record.id,
          reason: "Memory doctor: e2e marker/noise candidate"
        },
        safe_to_run: false
      });
    });
  });

  it("diagnoses duplicate and conflicting candidates without mutating records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-06-19T01:00:${String(tick++).padStart(2, "0")}.000Z`
      });
      const duplicateOne = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Use dashboard approvals for canonical memory.", format: "text" },
        source: { client: "codex" }
      });
      const duplicateTwo = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Use dashboard approvals for canonical memory.", format: "text" },
        source: { client: "claude" }
      });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["storage"],
        content: { text: "Use SQLite for the local event store.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const conflicting = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["storage"],
        content: { text: "Use JSONL for the local event store.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const doctor = await engine.memoryDoctor({ project_id: "moryn", limit: 20 });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(doctor.findings_by_id.duplicate_candidates).toMatchObject({
        id: "duplicate_candidates",
        category: "candidate_quality",
        severity: "warning",
        record_ids: [duplicateOne.record.id, duplicateTwo.record.id]
      });
      expect(doctor.findings_by_id.conflicting_candidates).toMatchObject({
        id: "conflicting_candidates",
        category: "candidate_quality",
        severity: "warning",
        record_ids: [conflicting.record.id]
      });
      expect(doctor.suggested_actions_by_id[`link_duplicate:${duplicateTwo.record.id}`]).toMatchObject({
        recommended_action: "link_duplicate_candidate",
        tool: "link",
        command: `moryn link ${duplicateTwo.record.id} ${duplicateOne.record.id} --type duplicate_of`,
        arguments: {
          record_id: duplicateTwo.record.id,
          linked_record_id: duplicateOne.record.id,
          link_type: "duplicate_of"
        },
        safe_to_run: false
      });
      expect(doctor.suggested_actions_by_id[`archive_duplicate:${duplicateTwo.record.id}`]).toMatchObject({
        recommended_action: "archive_duplicate_candidate",
        tool: "archive",
        command: `moryn archive ${duplicateTwo.record.id} --reason 'Memory doctor: duplicate candidate after linking or review'`,
        safe_to_run: false
      });
      expect(doctor.suggested_actions_by_id[`revise_conflict:${conflicting.record.id}`]).toMatchObject({
        recommended_action: "revise_conflicting_candidate",
        tool: "revise",
        command: `moryn revise ${conflicting.record.id} --reason 'Memory doctor: resolve semantic conflict before promotion'`,
        arguments: {
          record_id: conflicting.record.id,
          patch: {},
          reason: "Memory doctor: resolve semantic conflict before promotion"
        },
        safe_to_run: false
      });
      expect(doctor.suggested_actions_by_id[`inspect_conflict:${conflicting.record.id}`]).toMatchObject({
        recommended_action: "inspect_conflict_timeline",
        tool: "timeline",
        command: `moryn timeline --record-id ${conflicting.record.id} --project-id moryn --before 3 --after 3`,
        arguments: {
          record_id: conflicting.record.id,
          project_id: "moryn",
          before: 3,
          after: 3
        },
        safe_to_run: true
      });
      expect(doctor.records_by_id[duplicateOne.record.id]?.id).toBe(duplicateOne.record.id);
      expect(doctor.records_by_id[duplicateTwo.record.id]?.id).toBe(duplicateTwo.record.id);
      expect(doctor.records_by_id[conflicting.record.id]?.conflict?.with).toEqual([existing.record.id]);
    });
  });

  it("reports memory lifecycle review states without mutating or exposing private records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let currentTime = "2026-01-01T00:00:00.000Z";
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => currentTime,
        id: (prefix) => `${prefix}_${++nextId}`
      });

      currentTime = "2026-01-01T00:00:00.000Z";
      const staleCandidate = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["v0.1"],
        content: { text: "Old candidate: use the scratch dashboard route.", format: "text" },
        confidence: 0.35,
        source: { client: "codex" }
      });
      currentTime = "2026-01-02T00:00:00.000Z";
      const staleCanonical = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Canonical decision from the old dashboard design.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      currentTime = "2026-01-03T00:00:00.000Z";
      const retainedRule = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        priority: "high",
        content: { text: "Keep Moryn local-first and user-owned.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      currentTime = "2026-06-15T00:00:00.000Z";
      const recentCandidate = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Recent lifecycle note should stay active.", format: "text" },
        source: { client: "codex" }
      });
      currentTime = "2026-01-04T00:00:00.000Z";
      const privateCandidate = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private lifecycle finding must stay hidden.", format: "text" },
        source: { client: "codex" }
      });

      currentTime = "2026-06-20T00:00:00.000Z";
      const beforeEvents = await readEvents(storePath);
      const report = await engine.memoryLifecycle({ project_id: "moryn", limit: 20 });
      const afterEvents = await readEvents(storePath);

      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(report).toMatchObject({
        read_only: true,
        version: 1,
        scope: "local_store",
        project_id: "moryn",
        policy: {
          id: "default_memory_lifecycle_policy",
          stale_after_days: 30,
          archive_after_days: 90
        }
      });
      expect(report.selection_sources).toEqual(MEMORY_LIFECYCLE_SELECTION_SOURCES);
      expect(report.stats).toMatchObject({
        total_records: 4,
        excluded_private_records: 1,
        retained_records: 2,
        stale_records: 1,
        archive_candidate_records: 1
      });
      expect(report.assessments_by_record_id[staleCandidate.record.id]).toMatchObject({
        record_id: staleCandidate.record.id,
        lifecycle_state: "archive_candidate",
        recommended_action: "archive_after_review"
      });
      expect(report.assessments_by_record_id[staleCandidate.record.id]?.reasons).toEqual(expect.arrayContaining([
        "older_than_archive_after_days",
        "low_confidence_candidate"
      ]));
      expect(report.assessments_by_record_id[staleCanonical.record.id]).toMatchObject({
        record_id: staleCanonical.record.id,
        lifecycle_state: "stale",
        recommended_action: "inspect_timeline"
      });
      expect(report.assessments_by_record_id[retainedRule.record.id]).toMatchObject({
        record_id: retainedRule.record.id,
        lifecycle_state: "retained",
        recommended_action: "keep"
      });
      expect(report.assessments_by_record_id[recentCandidate.record.id]).toMatchObject({
        record_id: recentCandidate.record.id,
        lifecycle_state: "retained",
        recommended_action: "keep"
      });
      expect(report.assessments_by_record_id[privateCandidate.record.id]).toBeUndefined();
      expect(report.findings_by_id.archive_candidates).toMatchObject({
        category: "archive_candidates",
        severity: "warning",
        record_ids: [staleCandidate.record.id]
      });
      expect(report.findings_by_id.stale_records).toMatchObject({
        category: "stale_records",
        severity: "info",
        record_ids: [staleCanonical.record.id]
      });
      expect(report.suggested_actions_by_id[`archive:${staleCandidate.record.id}`]).toMatchObject({
        tool: "archive",
        safe_to_run: false,
        command: `moryn archive ${staleCandidate.record.id} --reason 'Memory lifecycle: archive stale low-confidence candidate'`,
        arguments: {
          record_id: staleCandidate.record.id,
          reason: "Memory lifecycle: archive stale low-confidence candidate"
        }
      });
      expect(report.suggested_actions_by_id[`inspect:${staleCanonical.record.id}`]).toMatchObject({
        tool: "timeline",
        safe_to_run: true,
        arguments: {
          record_id: staleCanonical.record.id,
          project_id: "moryn",
          before: 3,
          after: 3
        }
      });
      expect(report.records_by_id[staleCandidate.record.id]?.id).toBe(staleCandidate.record.id);
      expect(report.records_by_id[privateCandidate.record.id]).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("Private lifecycle finding");

      const privateReport = await engine.memoryLifecycle({ project_id: "moryn", include_private: true, now: "2026-06-20T00:00:00.000Z" });
      expect(privateReport.stats.private_retained_records).toBe(1);
      expect(privateReport.assessments_by_record_id[privateCandidate.record.id]).toMatchObject({
        record_id: privateCandidate.record.id,
        lifecycle_state: "private_retained",
        recommended_action: "keep"
      });
    });
  });

  it("writes, recalls, revises, and promotes records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use GitHub sync.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      expect(written.selection_sources).toEqual(WRITE_SELECTION_SOURCES);
      const revised = await engine.revise({ record_id: written.record.id, patch: { "content.text": "Use private GitHub sync." }, reason: "Clarify privacy" });
      const promoted = await engine.promote({ record_id: written.record.id, target_state: "canonical", reason: "User confirmed" });
      const linked = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use store-owned Git remotes.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      const link = await engine.link({ record_id: written.record.id, linked_record_id: linked.record.id, link_type: "related" });
      const archived = await engine.archive({ record_id: linked.record.id, reason: "Covered by primary decision" });
      const quarantined = await engine.quarantine({ record_id: linked.record.id, reason: "Needs review" });

      expect(revised.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
      expect(promoted.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
      expect(link.selection_sources).toEqual(LINK_EVENT_SELECTION_SOURCES);
      expect(archived.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
      expect(quarantined.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);

      const recall = await engine.recall({ query: "github sync", project_id: "moryn", limit: 5 });
      expect(recall.results[0]?.record.content.text).toBe("Use private GitHub sync.");
      expect(recall.results[0]?.record.state).toBe("canonical");
    });
  });

  it("persists validated agent-proposed logical relationships with reasons", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", source: { client: "codex" } } as const;
      const source = await engine.write({ ...base, content: { text: "Use checkpoint before compact" } });
      const target = await engine.write({ ...base, content: { text: "Checkpoint long-running tasks" } });

      const result = await engine.logicalLink({
        record_id: source.record.id,
        linked_record_id: target.record.id,
        relationship: "supports",
        reason: "The first decision supports the broader lifecycle rule",
        source: { client: "codex" }
      });
      const recalled = await engine.recall({ record_ids: [source.record.id] });

      expect(result).toMatchObject({ relationship: "supports", direction: "directed", reason: "The first decision supports the broader lifecycle rule" });
      expect(recalled.results[0]?.record.links).toContainEqual(expect.objectContaining({
        record_id: target.record.id,
        link_type: "supports",
        reason: "The first decision supports the broader lifecycle rule"
      }));
    });
  });

  it("uses the active logical view for default recall and boot while preserving direct audit lookup", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", state: "canonical", confirmed: true, source: { client: "user" } } as const;
      const old = await engine.write({ ...base, content: { text: "Use manual sync" } });
      const current = await engine.write({ ...base, content: { text: "Use autonomous sync" } });
      await engine.logicalLink({ record_id: current.record.id, linked_record_id: old.record.id, relationship: "supersedes", reason: "Autopilot replaces manual sync" });

      const defaultRecall = await engine.recall({ project_id: "moryn" });
      const directRecall = await engine.recall({ record_ids: [old.record.id] });
      const boot = await engine.boot({ project_id: "moryn" });

      expect(defaultRecall.results.map((result) => result.record.id)).toContain(current.record.id);
      expect(defaultRecall.results.map((result) => result.record.id)).not.toContain(old.record.id);
      expect(directRecall.results[0]?.record.id).toBe(old.record.id);
      expect(boot.project.important_decisions.map((record: { id: string }) => record.id)).toContain(current.record.id);
      expect(boot.project.important_decisions.map((record: { id: string }) => record.id)).not.toContain(old.record.id);
    });
  });

  it("returns explicit recall outcomes and does not pad knowledge gaps", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn uses an append-only database" },
        state: "canonical",
        confidence: 0.9,
        confirmed: true,
        source: { client: "user" }
      });

      const gap = await engine.recall({ query: "deployment rollback policy", project_id: "moryn" });
      const match = await engine.recall({ query: "moryn append-only database", project_id: "moryn" });

      expect(gap.outcome).toMatchObject({ status: "knowledge_gap", recommended_action: "explore_then_capture_learning" });
      expect(gap.results).toEqual([]);
      expect(gap.next_actions.map((action) => action.id)).toEqual([
        "explore_external_sources",
        "capture_confirmed_learning",
        "preserve_unresolved_investigation"
      ]);
      expect(gap.next_actions_by_id.capture_confirmed_learning.destinations).toEqual([
        "checkpoint.delta.learnings[]",
        "finish.learnings[]"
      ]);
      expect(match.outcome).toMatchObject({ status: "trusted_match", trust: "trusted", recommended_action: "use_recalled_knowledge" });
      expect(match.results).toHaveLength(1);
      expect(match.next_actions.map((action) => action.id)).toEqual([
        "use_recalled_knowledge",
        "inspect_record_timeline"
      ]);
      expect(match.next_actions_by_id.inspect_record_timeline.interfaces.mcp).toMatchObject({
        tool: "timeline",
        arguments: { record_id: match.results[0]?.record.id, include_private: false }
      });
      expect(match.selection_sources.next_action).toBe("next_actions_by_id.<action_id>");
    });
  });

  it("ingests reliable learning idempotently across agents", async () => {
    await withInitializedTempStore(async (storePath) => {
      const codex = createEngine({ storePath });
      const claude = createEngine({ storePath });
      const learning = {
        question: "When does Moryn pull?",
        conclusion: "Moryn pulls on agent enter.",
        evidence_type: "source_code",
        scope: "project",
        confidence: 0.9,
        recommended_kind: "memory",
        recommended_type: "fact",
        related_record_ids: []
      } as const;

      const [first, second] = await Promise.all([
        codex.ingestLearnings({ project_id: "moryn", learnings: [learning], occurred_at: "2026-07-11T00:00:00.000Z", source: { client: "codex", session_id: "codex-a", device_id: "device-a" } }),
        claude.ingestLearnings({ project_id: "moryn", learnings: [{ ...learning, question: "What happens when an agent starts?" }], occurred_at: "2026-07-11T00:00:00.000Z", source: { client: "claude-code", session_id: "claude-a", device_id: "device-b" } })
      ]);
      const events = await readEvents(storePath);
      const learningEvents = events.filter((event) => event.op === "upsert_record" && event.record.tags.includes("learning"));

      expect(first.dispositions[0]?.record_id).toBe(second.dispositions[0]?.record_id);
      expect([first.dispositions[0]?.created, second.dispositions[0]?.created].sort()).toEqual([false, true]);
      expect(learningEvents).toHaveLength(1);
      expect(learningEvents[0]?.op === "upsert_record" ? learningEvents[0].record.state : undefined).toBe("canonical");
    });
  });

  it("keeps risky learning as a confirmation-required candidate", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const result = await engine.ingestLearnings({
        project_id: "moryn",
        occurred_at: "2026-07-11T00:00:00.000Z",
        source: { client: "codex", session_id: "session-a", device_id: "device-a" },
        learnings: [{ question: "What is the sync config?", conclusion: "Use origin main", evidence_type: "user_confirmed", scope: "project", confidence: 1, recommended_kind: "memory", recommended_type: "sync_configuration", related_record_ids: [] }]
      });
      expect(result.dispositions[0]).toMatchObject({ state: "candidate", requires_confirmation: true, policy_reason: "high_risk_learning_requires_confirmation" });
    });
  });

  it("lists project activity for agent project discovery", async () => {
    await withInitializedTempStore(async (storePath) => {
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z"
      ];
      let nextId = 0;
      let nextTime = 0;
      const engine = createEngine({
        storePath,
        now: () => timestamps[nextTime++] ?? "2026-05-27T00:04:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "alpha",
        tags: ["typescript"],
        content: { text: "Alpha uses TypeScript.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const betaStatus = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "beta",
        tags: ["python"],
        content: {
          text: "Codex is actively working on Beta.",
          format: "json",
          current_task: "beta migration"
        },
        source: { client: "codex", session_id: "codex-beta" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "alpha",
        tags: ["typescript"],
        content: { text: "Alpha handoff is ready.", format: "text" },
        source: { client: "gemini", session_id: "gemini-alpha" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "gamma",
        content: { text: "Gamma is archived.", format: "text" },
        state: "archived",
        source: { client: "test" }
      });

      const projects = await engine.listProjects();

      expect(projects.projects.map((project) => project.project_id)).toEqual(["alpha", "beta"]);
      expect(projects.selection_sources).toEqual({
        project: "projects_by_id.<project_id>",
        project_id: "projects_by_id.<project_id>.project_id",
        next_action: "projects_by_id.<project_id>.next"
      });
      expect(projects.projects_by_id.alpha).toEqual(projects.projects[0]);
      expect(projects.projects_by_id.beta).toEqual(projects.projects[1]);
      expect(projects.projects[0]).toMatchObject({
        project_id: "alpha",
        records: 2,
        tags: ["typescript"],
        latest_activity: {
          kind: "session_summary",
          type: "summary",
          text: "Alpha handoff is ready.",
          agent: { client: "gemini", session_id: "gemini-alpha" }
        },
        next: {
          recommended_action: "call_agent_start",
          action_source: "project_list.projects_by_id.alpha.next",
          tool: "agent_start",
          command: "moryn agent start --project-id alpha",
          arguments: { project_id: "alpha" },
          selection_sources: {
            project: "project_list.projects_by_id.<project_id>",
            project_id: "project_list.projects_by_id.<project_id>.project_id",
            next_action: "project_list.projects_by_id.<project_id>.next",
            ordered_next_action: "project_list.projects[].next",
            argument: "project_list.projects_by_id.<project_id>.next.arguments_by_name.<argument>",
            ordered_argument: "project_list.projects[].next.arguments_by_name.<argument>",
            required_field: "project_list.projects_by_id.<project_id>.next.required_fields_by_name.<field>",
            ordered_required_field: "project_list.projects[].next.required_fields_by_name.<field>",
            required_input: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_field.<field>",
            ordered_required_input: "project_list.projects[].next.execution.required_inputs_by_field.<field>",
            required_input_argument_path: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_argument_path.<argument_path>",
            ordered_required_input_argument_path: "project_list.projects[].next.execution.required_inputs_by_argument_path.<argument_path>",
            argument_source: "project_list.projects_by_id.<project_id>.next.argument_sources.<field>",
            ordered_argument_source: "project_list.projects[].next.argument_sources.<field>"
          }
        }
      });
      expect(projects.projects[1]).toMatchObject({
        project_id: "beta",
        records: 1,
        latest_activity: {
          record_id: betaStatus.record.id,
          type: "status",
          text: "Codex is actively working on Beta.",
          current_task: "beta migration",
          agent: { client: "codex", session_id: "codex-beta" }
        }
      });
      expect(projects.projects_by_id.alpha.next.workflow).toEqual({
        version: 1,
        start: "next",
        continue_from: ["project_list.projects_by_id.<project_id>.next", "project_list.projects[].next"],
        phases: [
          {
            phase: "call_agent_start",
            order: 1,
            action_source: "project_list.projects_by_id.<project_id>.next",
            tool: "agent_start",
            required_when: "After choosing this project from project_list results.",
            required_fields: []
          }
        ],
        phases_by_name: {
          call_agent_start: {
            phase: "call_agent_start",
            order: 1,
            action_source: "project_list.projects_by_id.<project_id>.next",
            tool: "agent_start",
            required_when: "After choosing this project from project_list results.",
            required_fields: []
          }
        }
      });
      expect(projects.projects_by_id.beta.next.action_source).toBe("project_list.projects_by_id.beta.next");
    });
  });

  it("prefills project discovery next actions with agent startup context", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-05-27T00:00:00.000Z",
        id: (prefix) => `${prefix}_1`
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "alpha",
        content: { text: "Alpha handoff is ready.", format: "text" },
        source: { client: "codex", session_id: "codex-alpha" }
      });

      const projects = await engine.listProjects({
        current_task: "continue alpha handoff",
        sync_remote: "git@github.com:user/moryn-store.git",
        agent: {
          client: "gemini",
          session_id: "gemini-alpha",
          model: "gemini-pro",
          device_id: "laptop"
        }
      });

      expect(projects.projects[0]?.next).toMatchObject({
        recommended_action: "call_agent_start",
        tool: "agent_start",
        command: "moryn agent start --project-id alpha --sync-remote git@github.com:user/moryn-store.git --current-task 'continue alpha handoff' --agent gemini --session-id gemini-alpha --model gemini-pro --device-id laptop",
        arguments: {
          project_id: "alpha",
          sync_remote: "git@github.com:user/moryn-store.git",
          current_task: "continue alpha handoff",
          agent: {
            client: "gemini",
            session_id: "gemini-alpha",
            model: "gemini-pro",
            device_id: "laptop"
          }
        }
      });
    });
  });

  it("dry-runs and applies project identity migration", async () => {
    await withInitializedTempStore(async (storePath) => {
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z",
        "2026-05-27T00:04:00.000Z"
      ];
      let nextId = 0;
      let nextTime = 0;
      const engine = createEngine({
        storePath,
        now: () => timestamps[nextTime++] ?? "2026-05-27T00:05:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const oldProject = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old id should migrate.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const oldArchived = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Archived old id should migrate too.", format: "text" },
        state: "archived",
        source: { client: "test" }
      });
      const targetProject = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Target id already exists.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["private"],
        content: { text: "Private old id stays unless explicitly included.", format: "text" },
        source: { client: "test" }
      });

      const beforeEvents = await readEvents(storePath);
      const dryRun = await engine.migrateProject({
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn"
      });

      expect(dryRun).toMatchObject({
        dry_run: true,
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn",
        matched_records: 2,
        migrated_records: 0,
        skipped_private_records: 1,
        selection_sources: PROJECT_MIGRATE_SELECTION_SOURCES
      });
      expect(dryRun.records.map((record) => record.id)).toEqual([oldArchived.record.id, oldProject.record.id]);
      expect(dryRun.records_by_id[oldProject.record.id]).toEqual(expect.objectContaining({ project_id: "repo-e6f0166fd942" }));
      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);

      await expect(engine.migrateProject({
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn",
        dry_run: false
      })).rejects.toThrow("Confirmation required");

      const applied = await engine.migrateProject({
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn",
        dry_run: false,
        confirmed: true,
        source: { client: "test", session_id: "project-migrate" }
      });

      expect(applied).toMatchObject({
        dry_run: false,
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn",
        matched_records: 2,
        migrated_records: 2,
        skipped_private_records: 1,
        selection_sources: PROJECT_MIGRATE_SELECTION_SOURCES
      });
      expect(Object.keys(applied.events_by_record_id).sort()).toEqual([oldArchived.record.id, oldProject.record.id].sort());
      expect(applied.events).toHaveLength(2);
      expect(applied.events[0]).toMatchObject({
        op: "revise_record",
        patch: { project_id: "moryn" },
        reason: "Project identity migration: repo-e6f0166fd942 -> moryn",
        confirmed: true,
        source: { client: "test", session_id: "project-migrate" }
      });

      const projects = await engine.listProjects({ limit: 10 });
      expect(projects.projects.map((project) => project.project_id)).toEqual(["moryn"]);
      expect(projects.projects_by_id.moryn.records).toBe(2);
      expect((await engine.recall({ record_ids: [oldProject.record.id], project_id: "moryn" })).results[0]?.record.project_id).toBe("moryn");
      expect((await engine.recall({ record_ids: [oldArchived.record.id], states: ["archived"], project_id: "moryn" })).results[0]?.record.project_id).toBe("moryn");
      expect((await engine.recall({ record_ids: [targetProject.record.id], project_id: "moryn" })).results[0]?.record.project_id).toBe("moryn");
    });
  });

  it("preserves provenance on writes and canonical promotion", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use event provenance.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "sess_1" },
        provenance: {
          derived_from: ["rec_source"],
          reason: "Derived from the design discussion."
        }
      });

      expect(written.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "Derived from the design discussion.",
        method: "agent-proposed"
      });

      await engine.promote({
        record_id: written.record.id,
        target_state: "canonical",
        reason: "User confirmed this decision.",
        source: { client: "user" }
      });

      const recall = await engine.recall({ record_ids: [written.record.id] });
      expect(recall.results[0]?.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "User confirmed this decision.",
        method: "user-confirmed",
        promoted_at: "2026-05-27T00:00:00.001Z"
      });
    });
  });

  it("orders rapid same-millisecond mutations after the record creation event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const ids = ["rec_1", "evt_z_upsert", "evt_a_revise"];
      const engine = createEngine({
        storePath,
        now: () => "2026-05-27T00:00:00.000Z",
        id: (prefix) => ids.shift() ?? `${prefix}_extra`
      });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use old sync wording", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "Use private Git sync" },
        reason: "Clarified wording",
        source: { client: "test" }
      });

      const recall = await engine.recall({ record_ids: [written.record.id] });
      expect(recall.results[0]?.record.content.text).toBe("Use private Git sync");
    });
  });

  it("quarantines sensitive content on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "API_KEY=sk-1234567890abcdef", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
    });
  });

  it("quarantines authorization headers on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Authorization: Bearer ghp_1234567890abcdef", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "moryn" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "Authorization", project_id: "moryn" })).results).toHaveLength(0);

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("ghp_1234567890abcdef");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("redacts structured authorization fields before appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "Review request headers.",
          format: "text",
          authorization: "Bearer ghp_1234567890abcdef"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect(written.record.content.authorization).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("ghp_1234567890abcdef");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("rejects invalid core write arguments before appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      async function expectInvalidArgument(input: Parameters<typeof engine.write>[0], message: string): Promise<void> {
        try {
          await engine.write(input);
          throw new Error("Expected write to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
      }

      async function expectInvalidContentArgument(
        input: Parameters<typeof engine.write>[0],
        message: string,
        recoveryHint: unknown
      ): Promise<void> {
        try {
          await engine.write(input);
          throw new Error("Expected write to reject invalid content input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
          expect(envelope.error.recommended_action).toBe("retry write with valid content");
          expect(envelope.error.recovery_hint).toEqual(recoveryHint);
        }
      }

      async function expectInvalidWriteShapeArgument(
        input: Parameters<typeof engine.write>[0],
        message: string,
        recommendedAction: string,
        recoveryHint: unknown
      ): Promise<void> {
        try {
          await engine.write(input);
          throw new Error("Expected write to reject invalid shape input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
          expect(envelope.error.recommended_action).toBe(recommendedAction);
          expect(envelope.error.recovery_hint).toEqual(recoveryHint);
        }
      }

      await expectInvalidArgument(null as never, "Invalid write input");
      await expectInvalidWriteShapeArgument({
        kind: "note" as never,
        type: "decision",
        scope: "project",
        content: { text: "Invalid kind.", format: "text" },
        source: { client: "test" }
      }, "Invalid kind", "retry write with a supported kind", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "kind", value: "note" },
        expected: { kind: "allowed_values", allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"] },
        argument_sources: {
          kind: "operations_by_id.write.arguments_by_name.kind"
        },
        retry_with: { argument: "kind", value_placeholder: "memory" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "",
        scope: "project",
        content: { text: "Invalid type.", format: "text" },
        source: { client: "test" }
      }, "Invalid type", "retry write with a non-empty type", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "type", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          type: "operations_by_id.write.arguments_by_name.type"
        },
        retry_with: { argument: "type", value_placeholder: "<record type>" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "workspace" as never,
        content: { text: "Invalid scope.", format: "text" },
        source: { client: "test" }
      }, "Invalid scope", "retry write with a supported scope", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "scope", value: "workspace" },
        expected: { kind: "allowed_values", allowed_values: ["global", "project", "topic", "session", "artifact"] },
        argument_sources: {
          scope: "operations_by_id.write.arguments_by_name.scope"
        },
        retry_with: { argument: "scope", value_placeholder: "project" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "",
        content: { text: "Invalid project id.", format: "text" },
        source: { client: "test" }
      }, "Invalid project_id", "retry write with a valid project_id", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "project_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          project_id: "operations_by_id.write.arguments_by_name.project_id"
        },
        retry_with: { argument: "project_id", value_placeholder: "<project_id>" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid state.", format: "text" },
        state: "published" as never,
        source: { client: "test" }
      }, "Invalid state", "retry write with a supported state", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "state", value: "published" },
        expected: { kind: "allowed_values", allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"] },
        argument_sources: {
          state: "operations_by_id.write.arguments_by_name.state"
        },
        retry_with: { argument: "state", value_placeholder: "candidate" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid confidence.", format: "text" },
        confidence: 2,
        source: { client: "test" }
      }, "Invalid confidence", "retry write with confidence between 0 and 1", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "confidence", value: 2 },
        expected: { kind: "number_range", min: 0, max: 1, inclusive: true },
        argument_sources: {
          confidence: "operations_by_id.write.arguments_by_name.confidence"
        },
        retry_with: { argument: "confidence", value_placeholder: 0.5 }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid priority.", format: "text" },
        priority: "urgent" as never,
        source: { client: "test" }
      }, "Invalid priority", "retry write with a supported priority", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "priority", value: "urgent" },
        expected: { kind: "allowed_values", allowed_values: ["low", "normal", "high"] },
        argument_sources: {
          priority: "operations_by_id.write.arguments_by_name.priority"
        },
        retry_with: { argument: "priority", value_placeholder: "normal" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["valid", 123] as never,
        content: { text: "Invalid tags.", format: "text" },
        source: { client: "test" }
      }, "Invalid tags", "retry write with valid tags", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "tags", value: ["valid", 123] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          tags: "operations_by_id.write.arguments_by_name.tags"
        },
        retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: [""],
        content: { text: "Empty tag.", format: "text" },
        source: { client: "test" }
      }, "Invalid tags", "retry write with valid tags", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "tags", value: [""] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          tags: "operations_by_id.write.arguments_by_name.tags"
        },
        retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
      });
      await expectInvalidContentArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: "Invalid content." as never,
        source: { client: "test" }
      }, "Invalid content", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "content", value: "Invalid content." },
        expected: { kind: "content_object", required: true },
        argument_sources: {
          content: "operations_by_id.write.arguments_by_name.content"
        },
        retry_with: { argument: "content", value_placeholder: { text: "<text>", format: "text" } }
      });
      await expectInvalidContentArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: {},
        source: { client: "test" }
      }, "Invalid content", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "content", value: {} },
        expected: { kind: "non_empty_content_object", required: true },
        argument_sources: {
          content: "operations_by_id.write.arguments_by_name.content"
        },
        retry_with: { argument: "content", value_placeholder: { text: "<text>", format: "text" } }
      });
      await expectInvalidContentArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "", format: "text" },
        source: { client: "test" }
      }, "Invalid content.text", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "content.text", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "content.text": "operations_by_id.write.arguments_by_name.content_text"
        },
        retry_with: { argument: "content.text", value_placeholder: "<non-empty text>" }
      });
      await expectInvalidContentArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid format.", format: "markdown" as never },
        source: { client: "test" }
      }, "Invalid content.format", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "content.format", value: "markdown" },
        expected: { kind: "allowed_values", allowed_values: ["text", "json"] },
        argument_sources: {
          "content.format": "operations_by_id.write.arguments_by_name.content_format"
        },
        retry_with: { argument: "content.format", value_placeholder: "text" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid source.", format: "text" },
        source: { client: "" }
      }, "Invalid source.client", "retry write with a valid source client", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "source.client", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "source.client": "operations_by_id.write.arguments_by_name.source_client"
        },
        retry_with: { argument: "source.client", value_placeholder: "<client>" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid confirmed.", format: "text" },
        source: { client: "test" },
        confirmed: "yes" as never
      }, "Invalid confirmed", "retry write with a boolean confirmed value", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "confirmed", value: "yes" },
        expected: { kind: "boolean" },
        argument_sources: {
          confirmed: "operations_by_id.write.arguments_by_name.confirmed"
        },
        retry_with: { argument: "confirmed", value_placeholder: true }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid provenance.", format: "text" },
        source: { client: "test" },
        provenance: "imported" as never
      }, "Invalid provenance", "retry write with a valid provenance object", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance", value: "imported" },
        expected: { kind: "object", required: false },
        argument_sources: {
          provenance: "operations_by_id.write.arguments_by_name.provenance"
        },
        retry_with: { argument: "provenance", value_placeholder: { derived_from: ["<record_id>"], reason: "<reason>" } }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid provenance.", format: "text" },
        source: { client: "test" },
        provenance: { method: "imported" } as never
      }, "Invalid provenance.method", "retry write with a supported provenance method", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance.method", value: "imported" },
        expected: { kind: "allowed_values", allowed_values: ["agent-proposed", "rule-promoted", "user-confirmed"] },
        argument_sources: {
          "provenance.method": "operations_by_id.write.arguments_by_name.provenance_method"
        },
        retry_with: { argument: "provenance.method", value_placeholder: "agent-proposed" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Empty provenance source.", format: "text" },
        source: { client: "test" },
        provenance: { derived_from: [""] }
      }, "Invalid provenance.derived_from", "retry write with valid provenance source record ids", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance.derived_from", value: [""] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          "provenance.derived_from": "operations_by_id.write.arguments_by_name.derived_from"
        },
        retry_with: { argument: "provenance.derived_from", value_placeholder: ["<record_id>"] }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Empty provenance reason.", format: "text" },
        source: { client: "test" },
        provenance: { reason: "" }
      }, "Invalid provenance.reason", "retry write with a non-empty provenance reason", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance.reason", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "provenance.reason": "operations_by_id.write.arguments_by_name.reason"
        },
        retry_with: { argument: "provenance.reason", value_placeholder: "<reason>" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invalid provenance timestamp.", format: "text" },
        source: { client: "test" },
        provenance: { promoted_at: "not-a-date" }
      }, "Invalid provenance.promoted_at", "retry write with a valid provenance timestamp", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance.promoted_at", value: "not-a-date" },
        expected: { kind: "iso_datetime", format: "RFC3339 timestamp with timezone" },
        argument_sources: {
          "provenance.promoted_at": "operations_by_id.write.arguments_by_name.provenance_promoted_at"
        },
        retry_with: { argument: "provenance.promoted_at", value_placeholder: "<ISO datetime>" }
      });
      await expectInvalidWriteShapeArgument({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Date-only provenance timestamp.", format: "text" },
        source: { client: "test" },
        provenance: { promoted_at: "2026-05-27" }
      }, "Invalid provenance.promoted_at", "retry write with a valid provenance timestamp", {
        operation_contract: "operations_by_id.write",
        rejected_argument: { argument: "provenance.promoted_at", value: "2026-05-27" },
        expected: { kind: "iso_datetime", format: "RFC3339 timestamp with timezone" },
        argument_sources: {
          "provenance.promoted_at": "operations_by_id.write.arguments_by_name.provenance_promoted_at"
        },
        retry_with: { argument: "provenance.promoted_at", value_placeholder: "<ISO datetime>" }
      });

      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("quarantines records revised with sensitive content", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Review auth middleware before release.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const revised = await engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "Authorization: Bearer ghp_1234567890abcdef" },
        reason: "Pasted request header",
        source: { client: "test" }
      });

      expect(revised.selection_sources).toEqual(SENSITIVE_REVISE_SELECTION_SOURCES);
      expect(revised.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "moryn" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "Authorization", project_id: "moryn" })).results).toHaveLength(0);

      const quarantined = await engine.recall({
        record_ids: [written.record.id],
        states: ["quarantined"],
        project_id: "moryn"
      });
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
      expect(quarantined.results[0]?.record.visibility).toBe("quarantined");
      expect(quarantined.results[0]?.record.content.text).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("ghp_1234567890abcdef");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("rejects revisions that attempt to change managed record state fields", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use promotion events for state transitions.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await expect(engine.revise({
        record_id: written.record.id,
        patch: { state: "canonical" },
        reason: "Bypass promotion",
        source: { client: "test" }
      })).rejects.toThrow(/managed field/);

      const recall = await engine.recall({ record_ids: [written.record.id], states: ["candidate"] });
      expect(recall.results[0]?.record.state).toBe("candidate");
    });
  });

  it("rejects revisions that would produce an invalid record as invalid arguments", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Keep replayable records valid after revision.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      const originalEvents = await readEvents(storePath);

      try {
        await engine.revise({
          record_id: written.record.id,
          patch: { confidence: 2 },
          reason: "Invalid confidence",
          source: { client: "test" }
        });
        throw new Error("Expected invalid revision patch to reject");
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        expect(envelope.error.code).toBe("INVALID_ARGUMENT");
        expect(envelope.error.message).toContain("Invalid patch");
        expect(envelope.error.recommended_action).toBe("retry revise with a valid patch");
        expect(envelope.error.recovery_hint).toEqual({
          rejected_patch: { patch: { confidence: 2 } },
          expected: { kind: "valid_record_after_patch" },
          retry_with: { patch_placeholder: { "content.text": "<non-empty text>" } }
        });
      }
      await expect(engine.revise({
        record_id: written.record.id,
        patch: { "content.text": "" },
        reason: "Invalid content text",
        source: { client: "test" }
      })).rejects.toThrow(/Invalid patch/);

      const unchanged = await engine.recall({ record_ids: [written.record.id] });
      expect(unchanged.results[0]?.record.confidence).toBe(0.5);
      expect(unchanged.results[0]?.record.content.text).toBe("Keep replayable records valid after revision.");
      expect(await readEvents(storePath)).toHaveLength(originalEvents.length);
    });
  });

  it("rejects revisions that would create unconfirmed canonical conflicts", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await expect(engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "Agent inferred this replacement",
        source: { client: "agent" }
      })).rejects.toThrow(/conflicting canonical memory requires explicit user confirmation/);

      const unchanged = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(unchanged.results[0]?.record.content.text).toBe("Use private Git remotes.");
      expect(unchanged.results[0]?.record.type).toBe("warning");
      expect(unchanged.results[0]?.record.conflict).toBeUndefined();
      expect(existing.record.id).toBeTruthy();
    });
  });

  it("does not treat shared project tags alone as a semantic conflict", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["typescript", "mcp", "positioning"],
        content: { text: "Moryn should be positioned as a local-first personal context layer for AI agents, not as another vector-memory SDK.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const syncDecision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["typescript", "mcp", "sync", "dogfood"],
        content: { text: "Second-device sync can import Moryn GitHub private store history and push new events back.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(syncDecision.record.state).toBe("canonical");
      expect(syncDecision.record.conflict).toBeUndefined();
      expect(syncDecision.warning).toBeUndefined();
    });
  });

  it("records confirmed canonical revision conflicts without rewriting history", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "User confirmed the replacement",
        source: { client: "agent" },
        confirmed: true
      });

      const revised = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(revised.results[0]?.record.type).toBe("decision");
      expect(revised.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
      expect(revised.results[0]?.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });
    });
  });

  it("clears canonical revision conflicts after a confirmed non-conflicting revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const revisedTarget = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use private Git remotes.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
        reason: "User confirmed the replacement",
        source: { client: "agent" },
        confirmed: true
      });
      await engine.revise({
        record_id: revisedTarget.record.id,
        patch: { "content.text": "Use append-only JSON events." },
        reason: "User resolved the conflict",
        source: { client: "agent" }
      });

      const resolved = await engine.recall({ record_ids: [revisedTarget.record.id] });
      expect(resolved.results[0]?.record.content.text).toBe("Use append-only JSON events.");
      expect(resolved.results[0]?.record.conflict).toBeUndefined();
    });
  });

  it("scans full structured content for sensitive values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "Review deployment settings.",
          format: "text",
          header: "Authorization: Bearer ghp_1234567890abcdef"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");

      const clean = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Review deployment settings.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      const revised = await engine.revise({
        record_id: clean.record.id,
        patch: { "content.header": "Authorization: Bearer ghp_abcdef1234567890" },
        reason: "Added request sample",
        source: { client: "test" }
      });

      expect(revised.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      const quarantined = await engine.recall({ record_ids: [clean.record.id], states: ["quarantined"] });
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
    });
  });

  it("redacts sensitive structured values detected by field names", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "Review deployment settings.",
          format: "text",
          token: "abcdef1234567890"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.content.token).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("abcdef1234567890");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("quarantines cookie headers on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Cookie: session=abcdef1234567890; csrf=ghijklmnop123456", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.recall({ query: "session", project_id: "moryn" })).results).toHaveLength(0);
    });
  });

  it("quarantines pasted env files on write", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: {
          text: [
            "DATABASE_URL=postgres://moryn:secret@localhost:5432/moryn",
            "REDIS_URL=redis://localhost:6379",
            "SESSION_SECRET=abcdefghijklmnopqrstuvwxyz",
            "WEBHOOK_TOKEN=whsec_1234567890abcdef"
          ].join("\n"),
          format: "text"
        },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.record.visibility).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect((await engine.boot({ project_id: "moryn" })).project.warnings).toHaveLength(0);
      expect((await engine.recall({ query: "DATABASE_URL", project_id: "moryn" })).results).toHaveLength(0);
    });
  });

  it("quarantines large env-shaped content without obvious secret field names", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const envText = [
        "APP_ENV=production",
        "APP_HOST=internal.moryn.local",
        "PORT=3000",
        "LOG_LEVEL=debug",
        "FEATURE_FLAGS=sync,recall,mcp"
      ].join("\n");
      const written = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: envText, format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
      expect(written.record.content.text).toBe("[REDACTED_SECRET]");

      const eventLog = JSON.stringify(await readEvents(storePath));
      expect(eventLog).not.toContain("internal.moryn.local");
      expect(eventLog).toContain("[REDACTED_SECRET]");
    });
  });

  it("keeps high-risk canonical writes as candidates until user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const soul = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Always prefer terse answers.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });
      const globalSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Deploy production after smoke tests.", format: "text" },
        state: "canonical",
        source: { client: "mcp" }
      });
      const securityRule = await engine.write({
        kind: "memory",
        type: "security_rule",
        scope: "project",
        project_id: "moryn",
        content: { text: "Agents may rotate production credentials.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });
      const globalPreference = await engine.write({
        kind: "memory",
        type: "preference",
        scope: "global",
        content: { text: "Always prefer terse answers.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(soul.record.state).toBe("candidate");
      expect(soul.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(soul.warning?.next_action).toMatchObject({
        recommended_action: "ask_user_then_promote_candidate",
        tool: "promote",
        command: `moryn promote ${soul.record.id} --state canonical --reason 'User confirmed' --confirm`,
        candidate_record_id: soul.record.id,
        arguments: {
          record_id: soul.record.id,
          target_state: "canonical",
          reason: "User confirmed",
          confirmed: true
        },
        argument_sources: {
          record_id: "write.record.id"
        },
        interfaces: {
          cli: {
            command: `moryn promote ${soul.record.id} --state canonical --reason 'User confirmed' --confirm`
          },
          mcp: {
            tool: "promote",
            arguments: {
              record_id: soul.record.id,
              target_state: "canonical",
              reason: "User confirmed",
              confirmed: true
            }
          }
        },
        required_fields: [],
        safe_to_run: false
      });
      expectNextActionInterfaces(soul.warning!.next_action!);
      expectCandidatePromoteWorkflow(soul.warning!.next_action!);
      expectActionSafety(soul.warning!.next_action!);
      expect(soul.warning!.next_action!.safety).toMatchObject({
        safe_to_auto_run: false,
        requires_user_confirmation: true,
        requires_authored_input: false,
        writes_local_config: false
      });
      expect(soul.warning!.next_action!.safety?.reasons).toContain("requires_user_confirmation");
      expect(globalSkill.record.state).toBe("candidate");
      expect(globalSkill.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(securityRule.record.state).toBe("candidate");
      expect(securityRule.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(globalPreference.record.state).toBe("candidate");
      expect(globalPreference.warning?.code).toBe("CONFIRMATION_REQUIRED");

      const userConfirmed = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer direct engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      expect(userConfirmed.record.state).toBe("canonical");
      expect(userConfirmed.warning).toBeUndefined();

      const explicitlyConfirmed = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Run release checks before publishing.", format: "text" },
        state: "canonical",
        source: { client: "cli" },
        confirmed: true
      });
      expect(explicitlyConfirmed.record.state).toBe("canonical");
      expect(explicitlyConfirmed.warning).toBeUndefined();
    });
  });

  it("marks semantic conflicts and requires confirmation before conflicting canonical writes", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync", "storage"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const conflicting = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync", "storage"],
        content: { text: "Use SQLite as the source of truth.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(conflicting.record.state).toBe("candidate");
      expect(conflicting.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(conflicting.warning?.next_action).toMatchObject({
        recommended_action: "ask_user_then_promote_candidate",
        tool: "promote",
        command: `moryn promote ${conflicting.record.id} --state canonical --reason 'User confirmed' --confirm`,
        candidate_record_id: conflicting.record.id,
        arguments: {
          record_id: conflicting.record.id,
          target_state: "canonical",
          reason: "User confirmed",
          confirmed: true
        },
        argument_sources: {
          record_id: "write.record.id"
        },
        interfaces: {
          cli: {
            command: `moryn promote ${conflicting.record.id} --state canonical --reason 'User confirmed' --confirm`
          },
          mcp: {
            tool: "promote",
            arguments: {
              record_id: conflicting.record.id,
              target_state: "canonical",
              reason: "User confirmed",
              confirmed: true
            }
          }
        },
        required_fields: [],
        safe_to_run: false
      });
      expectNextActionInterfaces(conflicting.warning!.next_action!);
      expectCandidatePromoteWorkflow(conflicting.warning!.next_action!);
      expect(conflicting.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });

      const confirmed = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync", "storage"],
        content: { text: "Use SQLite for local indexes only.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      expect(confirmed.record.state).toBe("canonical");
      expect(confirmed.record.conflict?.with).toContain(existing.record.id);
    });
  });

  it("marks untagged same-subject canonical memory conflicts", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use append-only JSON events for sync storage.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const conflicting = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use SQLite as the source of truth for sync storage.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(conflicting.record.state).toBe("candidate");
      expect(conflicting.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(conflicting.record.conflict?.with).toEqual([existing.record.id]);
    });
  });

  it("does not mark unrelated untagged canonical memories as conflicts", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use append-only JSON events for sync storage.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const unrelated = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Render dashboard charts with canvas for performance.", format: "text" },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(unrelated.record.state).toBe("canonical");
      expect(unrelated.warning).toBeUndefined();
      expect(unrelated.record.conflict).toBeUndefined();
    });
  });

  it("does not mark unrelated structured canonical memories as conflicts from JSON metadata", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: {
          format: "json",
          summary: "Use append-only JSON events for sync storage."
        },
        state: "canonical",
        source: { client: "user" }
      });

      const unrelated = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: {
          format: "json",
          summary: "Render dashboard charts with canvas for performance."
        },
        state: "canonical",
        source: { client: "agent" }
      });

      expect(unrelated.record.state).toBe("canonical");
      expect(unrelated.warning).toBeUndefined();
      expect(unrelated.record.conflict).toBeUndefined();
    });
  });

  it("rejects conflicting canonical promotion without user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const candidate = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use SQLite as the source of truth.", format: "text" },
        state: "candidate",
        source: { client: "agent" }
      });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Use append-only JSON events.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      expect(candidate.record.conflict).toBeUndefined();

      await expect(engine.promote({
        record_id: candidate.record.id,
        target_state: "canonical",
        reason: "Agent inferred this replacement",
        source: { client: "agent" }
      })).rejects.toThrow(/conflicting canonical memory requires explicit user confirmation/);

      const stillCandidate = await engine.recall({ record_ids: [candidate.record.id], states: ["candidate"] });
      expect(stillCandidate.results[0]?.record.state).toBe("candidate");

      await engine.promote({
        record_id: candidate.record.id,
        target_state: "canonical",
        reason: "User confirmed",
        source: { client: "cli" },
        confirmed: true
      });

      const confirmed = await engine.recall({ record_ids: [candidate.record.id] });
      expect(confirmed.results[0]?.record.state).toBe("canonical");
      expect(confirmed.results[0]?.record.conflict).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });
    });
  });

  it("rejects high-risk canonical promotion without user confirmation", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const soul = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer very terse answers.", format: "text" },
        state: "candidate",
        source: { client: "codex" }
      });

      await expect(engine.promote({
        record_id: soul.record.id,
        target_state: "canonical",
        reason: "Agent inferred this preference",
        source: { client: "agent" }
      })).rejects.toThrow(/Confirmation required/);

      const stillCandidate = await engine.recall({ record_ids: [soul.record.id], states: ["candidate"] });
      expect(stillCandidate.results[0]?.record.state).toBe("candidate");

      await engine.promote({
        record_id: soul.record.id,
        target_state: "canonical",
        reason: "User confirmed",
        source: { client: "cli" },
        confirmed: true
      });
      const confirmed = await engine.recall({ record_ids: [soul.record.id] });
      expect(confirmed.results[0]?.record.state).toBe("canonical");
      expect(confirmed.results[0]?.record.provenance?.method).toBe("user-confirmed");
    });
  });

  it("recalls with record id, kind, type, state, tag, and file filters", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => `2026-05-27T00:00:0${nextId}.000Z`, id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["auth", "src/auth.ts"],
        content: { text: "Auth middleware uses signed cookies.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Run npm test before release.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "other",
        tags: ["auth"],
        content: { text: "Unrelated project warning.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        record_ids: [decision.record.id],
        project_id: "moryn",
        kinds: ["memory"],
        types: ["decision"],
        states: ["canonical"],
        tags: ["auth"],
        files: ["src/auth.ts"],
        limit: 5
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(decision.record.id);
      expect(recall.results[0]?.reason).toContain("record_id_match");
      expect(recall.results[0]?.reason).toContain("tag_match:auth");
      expect(recall.results[0]?.reason).toContain("file_match:src/auth.ts");
      expect(recall.selection_sources).toEqual({
        result: "results_by_id.<record_id>",
        record: "results_by_id.<record_id>.record",
        record_id: "results_by_id.<record_id>.record.id",
        next_action: "next_actions_by_id.<action_id>",
        ordered_next_action: "next_actions[]"
      });
      expect(recall.results_by_id[decision.record.id]).toEqual(recall.results[0]);
    });
  });

  it("recalls text and file matches from structured content values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => `2026-05-27T00:00:0${nextId}.000Z`, id: (prefix) => `${prefix}_${++nextId}` });

      const structured = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: {
          format: "json",
          summary: "Use signed cookies for auth middleware.",
          evidence: ["mcp-parity"],
          files: ["src/auth.ts"]
        },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        query: "mcp-parity",
        project_id: "moryn",
        files: ["src/auth.ts"],
        limit: 5
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(structured.record.id);
      expect(recall.results[0]?.reason).toContain("text_match:mcp-parity");
      expect(recall.results[0]?.reason).toContain("file_match:src/auth.ts");
    });
  });

  it("returns timeline context around a record anchor with recall next actions", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:01.000Z",
        "2026-05-27T00:00:02.000Z",
        "2026-05-27T00:00:03.000Z"
      ];
      const engine = createEngine({
        storePath,
        now: () => timestamps[nextTime++] ?? "2026-05-27T00:00:09.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const setup = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Keep dashboard generated from main.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const target = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Dashboard needs source links for review.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const followup = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Added dashboard provenance follow-up.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      const timeline = await engine.timeline({
        record_id: target.record.id,
        project_id: "moryn",
        before: 1,
        after: 1
      });

      expect(timeline.anchor).toEqual({
        event_id: "evt_4",
        record_id: target.record.id,
        source: "record_id"
      });
      expect(timeline.items.map((item) => item.relative)).toEqual(["before", "anchor", "after"]);
      expect(timeline.items.map((item) => item.record_id)).toEqual([setup.record.id, target.record.id, followup.record.id]);
      expect(timeline.items[1]).toMatchObject({
        event_id: "evt_4",
        op: "upsert_record",
        relative: "anchor",
        record_id: target.record.id,
        summary: "Dashboard needs source links for review.",
        record: {
          id: target.record.id,
          kind: "memory",
          type: "warning",
          state: "canonical",
          project_id: "moryn"
        }
      });
      expect(timeline.items[1]?.next_action).toMatchObject({
        recommended_action: "call_recall_with_record_id",
        tool: "recall",
        safe_to_run: true,
        command: `moryn recall --record-id ${target.record.id} --project-id moryn`,
        arguments: {
          record_ids: [target.record.id],
          project_id: "moryn"
        },
        argument_sources: {
          record_ids: "timeline.items_by_event_id.<event_id>.record_id"
        }
      });
      expectNextActionInterfaces(timeline.items[1]!.next_action);
      expect(timeline.items_by_event_id.evt_4).toEqual(timeline.items[1]);
      expect(timeline.items_by_record_id[target.record.id]).toEqual([timeline.items[1]]);
      expect(timeline.selection_sources).toEqual({
        anchor: "anchor",
        anchor_event_id: "anchor.event_id",
        anchor_record_id: "anchor.record_id",
        item: "items_by_event_id.<event_id>",
        item_event_id: "items_by_event_id.<event_id>.event_id",
        item_record_id: "items_by_event_id.<event_id>.record_id",
        item_next_action: "items_by_event_id.<event_id>.next_action",
        record_item: "items_by_record_id.<record_id>[]",
        ordered_item: "items[]",
        ordered_next_action: "items[].next_action"
      });
    });
  });

  it("hides private-tagged records from default reads unless explicitly included", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({
        storePath,
        now: () => timestamps[nextTime++] ?? "2026-05-27T00:03:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const publicRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["sync"],
        content: { text: "Public sync decision.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const privateRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private sync credential location.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const defaultRecall = await engine.recall({ query: "sync", project_id: "moryn", limit: 10 });
      expect(defaultRecall.results.map((result) => result.record.id)).toEqual([publicRecord.record.id]);

      const privateRecall = await engine.recall({
        query: "sync",
        project_id: "moryn",
        include_private: true,
        limit: 10
      });
      expect(privateRecall.results.map((result) => result.record.id)).toEqual([
        privateRecord.record.id,
        publicRecord.record.id
      ]);

      const boot = await engine.boot({ project_id: "moryn" });
      expect(boot.records_by_id[privateRecord.record.id]).toBeUndefined();
      expect(boot.recent_changes.map((record) => record.id)).toEqual([publicRecord.record.id]);

      const privateBoot = await engine.boot({ project_id: "moryn", include_private: true });
      expect(privateBoot.records_by_id[privateRecord.record.id]?.id).toBe(privateRecord.record.id);

      const refresh = await engine.refresh({ project_id: "moryn", cursor: "2026-05-27T00:00:00.000Z" });
      expect(refresh.changes.map((change) => change.record_id)).toEqual([publicRecord.record.id]);

      const privateRefresh = await engine.refresh({
        project_id: "moryn",
        cursor: "2026-05-27T00:00:00.000Z",
        include_private: true
      });
      expect(privateRefresh.changes.map((change) => change.record_id)).toEqual([
        publicRecord.record.id,
        privateRecord.record.id
      ]);
      expect(privateRefresh.changes.find((change) => change.record_id === privateRecord.record.id)?.next_action).toMatchObject({
        command: `moryn recall --record-id ${privateRecord.record.id} --project-id moryn --include-private`,
        arguments: {
          record_ids: [privateRecord.record.id],
          project_id: "moryn",
          include_private: true
        }
      });

      const recent = await engine.listRecent({ limit: 10 });
      expect(recent.records.map((record) => record.id)).toEqual([publicRecord.record.id]);

      const privateRecent = await engine.listRecent({ limit: 10, include_private: true });
      expect(privateRecent.records.map((record) => record.id)).toEqual([
        privateRecord.record.id,
        publicRecord.record.id
      ]);

      await expect(engine.timeline({
        record_id: privateRecord.record.id,
        project_id: "moryn",
        before: 0,
        after: 0
      })).rejects.toThrow(`Record not found: ${privateRecord.record.id}`);

      const privateTimeline = await engine.timeline({
        record_id: privateRecord.record.id,
        project_id: "moryn",
        before: 1,
        after: 0,
        include_private: true
      });
      expect(privateTimeline.items.map((item) => item.record_id)).toEqual([
        publicRecord.record.id,
        privateRecord.record.id
      ]);
      expect(privateTimeline.items_by_record_id[privateRecord.record.id]?.[0]?.next_action).toMatchObject({
        command: `moryn recall --record-id ${privateRecord.record.id} --project-id moryn --include-private`,
        arguments: {
          record_ids: [privateRecord.record.id],
          project_id: "moryn",
          include_private: true
        }
      });
    });
  });

  it("anchors timeline by event id or query", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:01.000Z",
        "2026-05-27T00:00:02.000Z",
        "2026-05-27T00:00:03.000Z"
      ];
      const engine = createEngine({
        storePath,
        now: () => timestamps[nextTime++] ?? "2026-05-27T00:00:09.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const setup = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Timeline should expose setup context.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const target = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Unique provenance citation anchor.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "other",
        content: { text: "Other project provenance citation anchor.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const byEvent = await engine.timeline({ event_id: "evt_2", project_id: "moryn", before: 0, after: 1 });
      expect(byEvent.anchor).toEqual({
        event_id: "evt_2",
        record_id: setup.record.id,
        source: "event_id"
      });
      expect(byEvent.items.map((item) => item.record_id)).toEqual([setup.record.id, target.record.id]);

      const byQuery = await engine.timeline({ query: "unique provenance", project_id: "moryn", before: 1, after: 0 });
      expect(byQuery.anchor).toEqual({
        event_id: "evt_4",
        record_id: target.record.id,
        source: "query"
      });
      expect(byQuery.items.map((item) => item.relative)).toEqual(["before", "anchor"]);
      expect(byQuery.items.map((item) => item.record_id)).toEqual([setup.record.id, target.record.id]);
    });
  });

  it("does not recall records solely from structured content metadata values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => `2026-05-27T00:00:0${nextId}.000Z`, id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: {
          format: "json",
          summary: "Structured metadata should not create a format-only match."
        },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        query: "json",
        project_id: "moryn",
        limit: 5
      });

      expect(recall.results).toEqual([]);
    });
  });

  it("recalls with explicit scope filtering", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "global",
        tags: ["policy"],
        content: { text: "Global policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["policy"],
        content: { text: "Project policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({ query: "policy", scopes: ["project"], project_id: "moryn" });

      expect(recall.results.map((result) => result.record.content.text)).toEqual(["Project policy memory."]);
    });
  });

  it("ranks recall by type importance and provenance trust", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth alpha middleware decision.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const agentWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth beta retry latency.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const ruleWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth gamma timeout threshold.", format: "text" },
        state: "canonical",
        source: { client: "moryn" }
      });

      const userWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth delta token expiry.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const recall = await engine.recall({ query: "auth", project_id: "moryn", kinds: ["memory"], limit: 4 });

      expect(recall.results.map((result) => result.record.id)).toEqual([
        userWarning.record.id,
        ruleWarning.record.id,
        agentWarning.record.id,
        decision.record.id
      ]);
      expect(recall.results[0]?.reason).toContain("type_priority:warning");
      expect(recall.results[0]?.reason).toContain("source_trust:user-confirmed");
      expect(recall.results[1]?.reason).toContain("source_trust:rule-promoted");
      expect(recall.results[2]?.reason).toContain("source_trust:agent-proposed");
    });
  });

  it("uses recency as a stable recall ranking tie-breaker", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextId] ?? "2026-05-27T00:02:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const older = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth middleware stores project records.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const newer = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth session refreshes derived indexes.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      expect(older.record.state).toBe("canonical");
      expect(newer.record.state).toBe("canonical");

      const recall = await engine.recall({ query: "auth", project_id: "moryn", kinds: ["memory"], limit: 2 });

      expect(recall.results.map((result) => result.record.id)).toEqual([newer.record.id, older.record.id]);
    });
  });

  it("ranks high-confidence recall candidates above lower-confidence candidates", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextId] ?? "2026-05-27T00:02:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const highConfidence = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth session refresh candidate with strong evidence.", format: "text" },
        state: "candidate",
        confidence: 0.9,
        source: { client: "codex" }
      });
      const lowConfidence = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Auth middleware candidate from an uncertain guess.", format: "text" },
        state: "candidate",
        confidence: 0.2,
        source: { client: "codex" }
      });

      const recall = await engine.recall({ query: "auth", project_id: "moryn", kinds: ["memory"], states: ["candidate"], limit: 2 });

      expect(recall.results.map((result) => result.record.id)).toEqual([highConfidence.record.id, lowConfidence.record.id]);
      expect(recall.results[0]?.reason).toContain("high_confidence_candidate");
    });
  });

  it("recalls an explicit record id even when the current project context differs", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const otherProject = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "other",
        content: { text: "Other project decision retrieved by exact id.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        record_ids: [otherProject.record.id],
        project_id: "moryn"
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(otherProject.record.id);
      expect(recall.results[0]?.reason).toContain("record_id_match");
    });
  });

  it("keeps raw agent notes out of default recall", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const note = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Raw implementation detail should stay source material.", format: "text" },
        source: { client: "agent-a" }
      });

      expect((await engine.recall({ query: "implementation detail", project_id: "moryn" })).results).toHaveLength(0);

      const explicit = await engine.recall({
        query: "implementation detail",
        project_id: "moryn",
        states: ["raw"]
      });
      expect(explicit.results[0]?.record.id).toBe(note.record.id);
    });
  });

  it("builds boot context from trusted profile, project, skill, and recent records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z",
        "2026-05-27T00:04:00.000Z",
        "2026-05-27T00:05:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const soul = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use append-only events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      const warning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Do not include secrets in memory.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      const skill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["moryn"],
        content: { text: "Run tests before committing.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { text: "Unrelated global skill.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Raw note should not boot.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.selection_sources).toEqual({
        record: "records_by_id.<record_id>",
        record_id: "records_by_id.<record_id>.id",
        user_preference: "profile.user_preferences_by_id.<record_id>",
        soul: "profile.soul_by_id.<record_id>",
        global_rule: "profile.global_rules_by_id.<record_id>",
        important_decision: "project.important_decisions_by_id.<record_id>",
        warning: "project.warnings_by_id.<record_id>",
        skill: "skills_by_id.<record_id>",
        task_relevant: "task_relevant_by_id.<record_id>",
        recent_change: "recent_changes_by_id.<record_id>",
        active_checkpoint: "active_checkpoint",
        checkpoint_recovery_pack: "checkpoint_recovery_pack"
      });
      expect(boot.profile.soul.map((record) => record.content.text)).toEqual(["Prefer concise engineering updates."]);
      expect(boot.project.important_decisions.map((record) => record.content.text)).toEqual(["Use append-only events."]);
      expect(boot.project.warnings.map((record) => record.content.text)).toEqual(["Do not include secrets in memory."]);
      expect(boot.profile.soul_by_id[soul.record.id]).toEqual(boot.profile.soul[0]);
      expect(boot.project.important_decisions_by_id[decision.record.id]).toEqual(boot.project.important_decisions[0]);
      expect(boot.project.warnings_by_id[warning.record.id]).toEqual(boot.project.warnings[0]);
      expect(boot.skills.map((record) => record.content.text)).toEqual(["Run tests before committing."]);
      expect(boot.skills_by_id[skill.record.id]).toEqual(boot.skills[0]);
      expect(boot.skills.map((record) => record.content.text)).not.toContain("Unrelated global skill.");
      expect(boot.recent_changes.map((record) => record.content.text)).not.toContain("Raw note should not boot.");
      expect(boot.recent_changes_by_id[warning.record.id]).toEqual(
        boot.recent_changes.find((record) => record.id === warning.record.id)
      );
      expect(boot.records_by_id[soul.record.id]).toEqual(boot.profile.soul[0]);
      expect(boot.records_by_id[decision.record.id]).toEqual(boot.project.important_decisions[0]);
      expect(boot.records_by_id[warning.record.id]).toEqual(boot.project.warnings[0]);
      expect(boot.records_by_id[skill.record.id]).toEqual(boot.skills[0]);
      expect(boot.sync.cursor).toBe("2026-05-27T00:05:00.000Z");
    });
  });

  it("compacts artifact payloads in boot context while preserving record ids for retrieval", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:01:00.000Z" });

      const artifact = await engine.write({
        kind: "skill",
        type: "codex_skill_bundle",
        scope: "global",
        tags: ["codex-skill", "portable-install", "encoded-bundle"],
        content: {
          format: "json",
          name: "portable helper bundle",
          path: "/home/user/.codex/skills/example/SKILL.md",
          sha256: "abc123",
          bytes: 4096,
          content_hex: "aa".repeat(4096),
          install_note: "Decode content_hex and write the file."
        },
        state: "canonical",
        priority: "high",
        source: { client: "test" },
        confirmed: true
      });

      const boot = await engine.boot({ default_skills: ["codex_skill_bundle"] });

      expect(boot.skills[0]).toMatchObject({
        id: artifact.record.id,
        content: {
          format: "json",
          name: "portable helper bundle",
          path: "/home/user/.codex/skills/example/SKILL.md",
          sha256: "abc123",
          bytes: 4096,
          omitted_fields: ["content_hex"],
          retrieve: {
            record_id: artifact.record.id,
            command: `moryn recall --record-id ${artifact.record.id}`
          }
        }
      });
      expect(boot.skills[0]!.content).not.toHaveProperty("content_hex");
      expect(boot.records_by_id[artifact.record.id]).toEqual(boot.skills[0]);

      const recalled = await engine.recall({ record_ids: [artifact.record.id] });

      expect(recalled.results[0]!.record.content.content_hex).toBe("aa".repeat(4096));
    });
  });

  it("marks boot sync status when the sync provider reports remote updates", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        syncStatus: async () => ({ behind: 2 })
      });

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.sync.remote_has_updates).toBe(true);
    });
  });

  it("builds project summary, tech stack, and active goals from trusted project records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn is a local-first agent memory layer.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "moryn",
        content: { text: "TypeScript", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "moryn",
        content: { text: "Node.js", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "active_goal",
        scope: "project",
        project_id: "moryn",
        content: { text: "Ship the first MCP-backed MVP.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "goal",
        scope: "project",
        project_id: "other",
        content: { text: "Other project goal.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "global",
        content: { text: "Global summary should not become project summary.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "moryn",
        content: { text: "Candidate stack entry.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.project.summary).toBe("Moryn is a local-first agent memory layer.");
      expect(boot.project.tech_stack).toEqual(["TypeScript", "Node.js"]);
      expect(boot.project.active_goals).toEqual(["Ship the first MCP-backed MVP."]);
    });
  });

  it("includes only important visible updates in boot recent changes", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const highConfidence = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Candidate release decision is ready for review.", format: "text" },
        state: "candidate",
        confidence: 0.9,
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Low confidence candidate should stay out.", format: "text" },
        state: "candidate",
        confidence: 0.4,
        source: { client: "test" }
      });
      const summary = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Session summary should appear in boot recents.", format: "text" },
        state: "candidate",
        confidence: 0.9,
        source: { client: "test" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Raw note should stay out of boot recents.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.recent_changes.map((record) => record.id)).toEqual([summary.record.id, highConfidence.record.id]);
    });
  });

  it("bounds boot context sections to the most relevant trusted records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.UTC(2026, 4, 27, 0, nextTime++, 0)).toISOString(),
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const decisionIds: string[] = [];
      const warningIds: string[] = [];
      const skillIds: string[] = [];
      const preferenceIds: string[] = [];
      const techStackTexts: string[] = [];
      const goalTexts: string[] = [];

      for (let index = 1; index <= 7; index++) {
        const preference = await engine.write({
          kind: "memory",
          type: "preference",
          scope: "global",
          content: { text: `Preference ${index}`, format: "text" },
          state: "canonical",
          source: { client: "user" }
        });
        preferenceIds.push(preference.record.id);

        const decision = await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          content: { text: `Decision ${index}`, format: "text" },
          state: "canonical",
          priority: index <= 2 ? "high" : "normal",
          source: { client: "test" }
        });
        decisionIds.push(decision.record.id);

        const warning = await engine.write({
          kind: "memory",
          type: index % 2 === 0 ? "blocker" : "warning",
          scope: "project",
          project_id: "moryn",
          content: { text: `Warning ${index}`, format: "text" },
          state: "canonical",
          priority: index <= 2 ? "high" : "normal",
          source: { client: "test" }
        });
        warningIds.push(warning.record.id);

        const skill = await engine.write({
          kind: "skill",
          type: "procedure",
          scope: "global",
          tags: ["moryn"],
          content: { text: `Skill ${index}`, format: "text" },
          state: "canonical",
          source: { client: "user" }
        });
        skillIds.push(skill.record.id);

        const techStack = await engine.write({
          kind: "memory",
          type: "tech_stack",
          scope: "project",
          project_id: "moryn",
          content: { text: `Tech ${index}`, format: "text" },
          state: "canonical",
          priority: index <= 2 ? "high" : "normal",
          source: { client: "test" }
        });
        techStackTexts.push(techStack.record.content.text);

        const goal = await engine.write({
          kind: "memory",
          type: "active_goal",
          scope: "project",
          project_id: "moryn",
          content: { text: `Goal ${index}`, format: "text" },
          state: "canonical",
          priority: index <= 2 ? "high" : "normal",
          source: { client: "test" }
        });
        goalTexts.push(goal.record.content.text);
      }

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.profile.user_preferences.map((record) => record.id)).toHaveLength(5);
      expect(boot.profile.user_preferences.map((record) => record.id)).toEqual(preferenceIds.slice(-5).reverse());
      expect(boot.project.important_decisions.map((record) => record.id)).toHaveLength(5);
      expect(boot.project.important_decisions.map((record) => record.id)).toEqual([
        decisionIds[1],
        decisionIds[0],
        decisionIds[6],
        decisionIds[5],
        decisionIds[4]
      ]);
      expect(boot.project.warnings.map((record) => record.id)).toHaveLength(5);
      expect(boot.project.warnings.map((record) => record.id)).toEqual([
        warningIds[1],
        warningIds[0],
        warningIds[6],
        warningIds[5],
        warningIds[4]
      ]);
      expect(boot.skills.map((record) => record.id)).toHaveLength(5);
      expect(boot.skills.map((record) => record.id)).toEqual(skillIds.slice(-5).reverse());
      expect(boot.project.tech_stack).toHaveLength(5);
      expect(boot.project.tech_stack).toEqual([
        techStackTexts[1],
        techStackTexts[0],
        techStackTexts[6],
        techStackTexts[5],
        techStackTexts[4]
      ]);
      expect(boot.project.active_goals).toHaveLength(5);
      expect(boot.project.active_goals).toEqual([
        goalTexts[1],
        goalTexts[0],
        goalTexts[6],
        goalTexts[5],
        goalTexts[4]
      ]);
    });
  });

  it("adds configured default skill selectors to boot context", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const releaseSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { name: "safe-release", text: "Run tests, typecheck, build, then publish.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { name: "unrelated-skill", text: "Do unrelated work.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });

      const boot = await engine.boot({ project_id: "moryn", default_skills: ["safe-release", releaseSkill.record.id] });

      expect(boot.skills.map((record) => record.id)).toEqual([releaseSkill.record.id]);
      expect(boot.skills[0]?.content.text).toBe("Run tests, typecheck, build, then publish.");
    });
  });

  it("matches configured default skill selectors against structured skill content", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const releaseSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["publishing"],
        content: {
          format: "json",
          purpose: "Safe release workflow for npm packages.",
          instructions: ["Run tests", "Run typecheck", "Build before publish"]
        },
        state: "canonical",
        source: { client: "user" }
      });

      const boot = await engine.boot({ project_id: "moryn", default_skills: ["release"] });

      expect(boot.skills.map((record) => record.id)).toEqual([releaseSkill.record.id]);
    });
  });

  it("matches configured default skill selectors against structured fields even when skill text exists", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const releaseSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["publishing"],
        content: {
          format: "json",
          text: "Run the release checklist.",
          purpose: "Safe npm package release workflow."
        },
        state: "canonical",
        source: { client: "user" }
      });

      const boot = await engine.boot({ project_id: "moryn", default_skills: ["npm"] });

      expect(boot.skills.map((record) => record.id)).toEqual([releaseSkill.record.id]);
    });
  });

  it("builds boot project text fields from structured content values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { format: "json", summary: "Moryn keeps structured boot context available." },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "tech_stack",
        scope: "project",
        project_id: "moryn",
        content: { format: "json", language: "TypeScript", runtime: "Node.js" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "active_goal",
        scope: "project",
        project_id: "moryn",
        content: { format: "json", summary: "Ship structured boot support." },
        state: "canonical",
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "moryn" });

      expect(boot.project.summary).toBe("Moryn keeps structured boot context available.");
      expect(boot.project.tech_stack).toEqual(["TypeScript Node.js"]);
      expect(boot.project.active_goals).toEqual(["Ship structured boot support."]);
    });
  });

  it("adds task-relevant trusted records to boot context when current task is provided", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const authDecision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["auth"],
        content: { text: "Auth token refresh uses rotating credentials.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Release skill from project config.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["release"],
        content: { text: "Release requires npm credentials.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        tags: ["auth"],
        content: { text: "Raw auth note should stay out of boot.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "moryn", current_task: "fix auth token refresh" });

      expect(boot.task_relevant.map((record) => record.id)).toEqual([authDecision.record.id]);
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Release requires npm credentials.");
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Release skill from project config.");
      expect(boot.task_relevant.map((record) => record.content.text)).not.toContain("Raw auth note should stay out of boot.");
    });
  });

  it("bounds task-relevant boot records by priority and recency", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.UTC(2026, 4, 27, 0, nextTime++, 0)).toISOString(),
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const matchingIds: string[] = [];
      for (let index = 1; index <= 7; index++) {
        const written = await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          tags: ["auth"],
          content: { text: `Auth token memory ${index}`, format: "text" },
          state: "canonical",
          priority: index >= 6 ? "high" : "normal",
          source: { client: "user" }
        });
        matchingIds.push(written.record.id);
      }

      const boot = await engine.boot({ project_id: "moryn", current_task: "fix auth token refresh" });

      expect(boot.task_relevant.map((record) => record.id)).toHaveLength(5);
      expect(boot.task_relevant.map((record) => record.id)).toEqual([
        matchingIds[6],
        matchingIds[5],
        matchingIds[4],
        matchingIds[3],
        matchingIds[2]
      ]);
    });
  });

  it("does not include arbitrary project records in boot without project context", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const preference = await engine.write({
        kind: "memory",
        type: "preference",
        scope: "global",
        content: { text: "Prefer direct engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "alpha",
        tags: ["auth"],
        content: { text: "Alpha auth token refresh uses rotating credentials.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "beta",
        tags: ["auth"],
        content: { text: "Beta auth token refresh is blocked by stale credentials.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const boot = await engine.boot({ current_task: "fix auth token refresh" });

      expect(boot.profile.user_preferences.map((record) => record.id)).toEqual([preference.record.id]);
      expect(boot.project.important_decisions).toEqual([]);
      expect(boot.project.warnings).toEqual([]);
      expect(boot.task_relevant).toEqual([]);
      expect(boot.recent_changes.map((record) => record.id)).toEqual([preference.record.id]);
      expect(boot.recent_changes.every((record) => record.scope === "global")).toBe(true);
    });
  });

  it("reports refresh changes since a cursor with notice and interrupt importance", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:05:00.000Z",
        "2026-05-27T00:06:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Session finished.", format: "text" },
        state: "raw",
        source: { client: "test" }
      });
      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use MCP for agent access.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const blocker = await engine.write({
        kind: "memory",
        type: "blocker",
        scope: "project",
        project_id: "moryn",
        content: { text: "Sync must not overwrite local events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({ project_id: "moryn", cursor: "2026-05-27T00:00:00.000Z" });

      expect(refresh.cursor).toBe("2026-05-27T00:06:00.000Z");
      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.selection_sources).toEqual({
        change: "changes_by_record_id.<record_id>",
        record_id: "changes_by_record_id.<record_id>.record_id",
        next_action: "changes_by_record_id.<record_id>.next_action"
      });
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: decision.record.id,
          importance: "notice",
          next_action: expect.any(Object)
        }),
        expect.objectContaining({
          record_id: blocker.record.id,
          importance: "interrupt",
          next_action: expect.any(Object)
        })
      ]);
      expect(refresh.changes_by_record_id[decision.record.id]).toEqual(refresh.changes[0]);
      expect(refresh.changes_by_record_id[blocker.record.id]).toEqual(refresh.changes[1]);
      expectRefreshChangeRecallAction(refresh.changes[0]!.next_action, decision.record.id, "moryn");
      expectRefreshChangeRecallAction(refresh.changes[1]!.next_action, blocker.record.id, "moryn");
      expect(refresh.changes_by_record_id[decision.record.id]!.next_action).toEqual(refresh.changes[0]!.next_action);
    });
  });

  it("keeps the refresh cursor at the last returned change when the change list is limited", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const first = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use event replay for refresh cursor tests.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const second = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Keep refresh pages bounded.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const third = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Do not skip later refresh changes.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const firstPage = await engine.refresh({ project_id: "moryn", cursor: "2026-05-27T00:00:00.000Z", limit: 2 });

      expect(firstPage.cursor).toBe(second.record.updated_at);
      expect(firstPage.changes.map((change) => change.record_id)).toEqual([first.record.id, second.record.id]);

      const secondPage = await engine.refresh({ project_id: "moryn", cursor: firstPage.cursor, limit: 2 });

      expect(secondPage.cursor).toBe(third.record.updated_at);
      expect(secondPage.changes.map((change) => change.record_id)).toEqual([third.record.id]);
    });
  });

  it("advances the refresh cursor past trailing silent changes after returning all reportable changes", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Refresh should report this decision.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const raw = await engine.write({
        kind: "memory",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Refresh should not report this raw note.", format: "text" },
        state: "raw",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({ project_id: "moryn", cursor: "2026-05-27T00:00:00.000Z", limit: 2 });

      expect(refresh.cursor).toBe(raw.record.updated_at);
      expect(refresh.changes.map((change) => change.record_id)).toEqual([decision.record.id]);
    });
  });

  it("summarizes refresh changes from structured content values", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:01:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const warning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: {
          format: "json",
          summary: "Structured refresh warning.",
          files: ["src/auth.ts"]
        },
        state: "canonical",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({ project_id: "moryn", cursor: "2026-05-27T00:00:00.000Z" });

      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: warning.record.id,
          summary: "Structured refresh warning. src/auth.ts"
        })
      ]);
    });
  });

  it("uses current task text to interrupt only on related blockers and warnings", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const authWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["auth"],
        content: { text: "Auth middleware has a token refresh blocker.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["release"],
        content: { text: "Release workflow needs npm credentials.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });

      const refresh = await engine.refresh({
        project_id: "moryn",
        cursor: "2026-05-26T00:00:00.000Z",
        current_task: "fix auth token refresh"
      });

      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: authWarning.record.id,
          importance: "interrupt",
          reason: "current_task_match"
        })
      ]);
    });
  });

  it("does not interrupt on arbitrary project refresh changes without project context", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const preference = await engine.write({
        kind: "memory",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "blocker",
        scope: "project",
        project_id: "alpha",
        tags: ["auth"],
        content: { text: "Alpha auth token refresh is blocked by stale credentials.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({
        cursor: "2026-05-26T00:00:00.000Z",
        current_task: "fix auth token refresh"
      });

      expect(refresh.should_interrupt).toBe(false);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: preference.record.id,
          importance: "notice"
        })
      ]);
    });
  });

  it("keeps raw agent notes out of boot until promotion and preserves skill identity through revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const rawNote = await engine.write({
        kind: "agent_note",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use candidate workflow before boot exposure.", format: "text" },
        source: { client: "agent-a" }
      });
      const hiddenBoot = await engine.boot({ project_id: "moryn" });
      expect(hiddenBoot.project.important_decisions).toHaveLength(0);

      await engine.promote({ record_id: rawNote.record.id, target_state: "canonical", reason: "User confirmed", source: { client: "user" } });
      const visibleBoot = await engine.boot({ project_id: "moryn" });
      expect(visibleBoot.project.important_decisions.map((record) => record.id)).toEqual([rawNote.record.id]);

      const skill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Run tests.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.revise({
        record_id: skill.record.id,
        patch: { "content.text": "Run tests and typecheck." },
        reason: "Refined workflow",
        source: { client: "agent-b" }
      });
      const recall = await engine.recall({ record_ids: [skill.record.id], kinds: ["skill"] });

      expect(recall.results[0]?.record.id).toBe(skill.record.id);
      expect(recall.results[0]?.record.content.text).toBe("Run tests and typecheck.");
    });
  });

  it("archives, quarantines, links, and recalls hidden records only when explicitly requested", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use durable links between related records.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const superseded = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Old sync strategy.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const sensitive = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Internal warning that should be quarantined.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      await engine.link({
        record_id: decision.record.id,
        linked_record_id: superseded.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      });
      await engine.archive({ record_id: superseded.record.id, reason: "Superseded", source: { client: "test" } });
      await engine.quarantine({ record_id: sensitive.record.id, reason: "Needs review", source: { client: "test" } });

      expect((await engine.recall({ query: "Old sync", project_id: "moryn" })).results).toHaveLength(0);
      expect((await engine.recall({ query: "Internal warning", project_id: "moryn" })).results).toHaveLength(0);

      const archived = await engine.recall({ record_ids: [superseded.record.id], states: ["archived"], project_id: "moryn" });
      const quarantined = await engine.recall({ record_ids: [sensitive.record.id], states: ["quarantined"], project_id: "moryn" });
      const linked = await engine.recall({ record_ids: [decision.record.id], project_id: "moryn" });

      expect(archived.results[0]?.record.state).toBe("archived");
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
      expect(linked.results[0]?.record.links).toEqual([
        {
          record_id: superseded.record.id,
          link_type: "supersedes",
          created_at: "2026-05-27T00:00:00.001Z"
        }
      ]);
    });
  });

  it("returns recent records with keyed lookup metadata", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-05-27T00:00:0${++tick}.000Z`
      });

      const first = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "global",
        content: { text: "First recent record.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const second = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "global",
        content: { text: "Second recent record.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recent = await engine.listRecent(2);

      expect(recent.records.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
      expect(recent.selection_sources).toEqual({
        record: "records_by_id.<record_id>",
        record_id: "records_by_id.<record_id>.id"
      });
      expect(recent.records_by_id[second.record.id]).toEqual(recent.records[0]);
      expect(recent.records_by_id[first.record.id]).toEqual(recent.records[1]);
    });
  });

  it("compacts artifact payloads in listRecent by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:01:00.000Z" });
      const artifact = await engine.write({
        kind: "skill",
        type: "codex_helper_full_content",
        scope: "global",
        tags: ["full-content", "portable-install"],
        content: {
          format: "json",
          label: "helper",
          path: "/home/user/helper.py",
          sha256: "def456",
          size: 2048,
          content_hex: "bb".repeat(2048)
        },
        state: "candidate",
        priority: "high",
        source: { client: "test" }
      });

      const recent = await engine.listRecent(1);

      expect(recent.records[0]).toMatchObject({
        id: artifact.record.id,
        content: {
          format: "json",
          label: "helper",
          path: "/home/user/helper.py",
          sha256: "def456",
          size: 2048,
          omitted_fields: ["content_hex"],
          retrieve: {
            record_id: artifact.record.id,
            command: `moryn recall --record-id ${artifact.record.id}`
          }
        }
      });
      expect(recent.records[0]!.content).not.toHaveProperty("content_hex");
      expect(recent.records_by_id[artifact.record.id]).toEqual(recent.records[0]);
    });
  });

  it("rejects invalid core result limits", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      async function expectInvalidLimit(action: () => Promise<unknown>, operation: "recall" | "refresh" | "list_recent" | "project_list", value: number): Promise<void> {
        try {
          await action();
          throw new Error("Expected read to reject invalid limit");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain("Invalid limit");
          expect(envelope.error.recommended_action).toBe("retry read with a limit between 1 and 100");
          expect(envelope.error.recovery_hint).toEqual({
            operation_contract: `operations_by_id.${operation}`,
            rejected_argument: { argument: "limit", value },
            expected: { kind: "integer_range", min: 1, max: 100, integer: true },
            argument_sources: {
              limit: `operations_by_id.${operation}.arguments_by_name.limit`
            },
            retry_with: { argument: "limit", value_placeholder: 10 }
          });
        }
      }

      await expectInvalidLimit(() => engine.recall({ limit: 0 }), "recall", 0);
      await expectInvalidLimit(() => engine.refresh({ limit: 101 }), "refresh", 101);
      await expectInvalidLimit(() => engine.listRecent(-1), "list_recent", -1);
      await expectInvalidLimit(() => engine.listProjects({ limit: 101 }), "project_list", 101);

      try {
        await engine.timeline({ record_id: "rec_1", before: -1 });
        throw new Error("Expected timeline to reject invalid before");
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        expect(envelope.error.code).toBe("INVALID_ARGUMENT");
        expect(envelope.error.message).toContain("Invalid before");
        expect(envelope.error.recommended_action).toBe("retry read with a timeline window between 0 and 50");
        expect(envelope.error.recovery_hint).toEqual({
          operation_contract: "operations_by_id.timeline",
          rejected_argument: { argument: "before", value: -1 },
          expected: { kind: "integer_range", min: 0, max: 50, integer: true },
          argument_sources: {
            before: "operations_by_id.timeline.arguments_by_name.before"
          },
          retry_with: { argument: "before", value_placeholder: 5 }
        });
      }
    });
  });

  it("rejects invalid core read arguments", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });

      async function expectInvalidArgument(action: () => Promise<unknown>, message: string): Promise<void> {
        try {
          await action();
          throw new Error("Expected read to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
      }

      async function expectInvalidReadShapeArgument(
        action: () => Promise<unknown>,
        message: string,
        recommendedAction: string,
        recoveryHint: unknown
      ): Promise<void> {
        try {
          await action();
          throw new Error("Expected read to reject invalid shape input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
          expect(envelope.error.recommended_action).toBe(recommendedAction);
          expect(envelope.error.recovery_hint).toEqual(recoveryHint);
        }
      }

      await expectInvalidArgument(() => engine.recall(null as never), "Invalid recall input");
      await expectInvalidReadShapeArgument(() => engine.recall({ project_id: "" }), "Invalid project_id", "retry read with a non-empty project_id", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "project_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          project_id: "operations_by_id.recall.arguments_by_name.project_id"
        },
        retry_with: { argument: "project_id", value_placeholder: "<project_id>" }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ query: 123 as never }), "Invalid query", "retry read with a non-empty query", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "query", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          query: "operations_by_id.recall.arguments_by_name.query"
        },
        retry_with: { argument: "query", value_placeholder: "<query>" }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ record_ids: ["rec_1", 123] as never }), "Invalid record_ids", "retry read with record_ids as non-empty strings", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "record_ids", value: ["rec_1", 123] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          record_ids: "operations_by_id.recall.arguments_by_name.record_ids"
        },
        retry_with: { argument: "record_ids", value_placeholder: ["<record_id>"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ kinds: ["note"] as never }), "Invalid kinds", "retry read with supported kinds", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "kinds", value: ["note"] },
        expected: { kind: "array_of_allowed_values", allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"] },
        argument_sources: {
          kinds: "operations_by_id.recall.arguments_by_name.kinds"
        },
        retry_with: { argument: "kinds", value_placeholder: ["memory"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ scopes: ["repository"] as never }), "Invalid scopes", "retry read with supported scopes", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "scopes", value: ["repository"] },
        expected: { kind: "array_of_allowed_values", allowed_values: ["global", "project", "topic", "session", "artifact"] },
        argument_sources: {
          scopes: "operations_by_id.recall.arguments_by_name.scopes"
        },
        retry_with: { argument: "scopes", value_placeholder: ["project"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ states: ["published"] as never }), "Invalid states", "retry read with supported states", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "states", value: ["published"] },
        expected: { kind: "array_of_allowed_values", allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"] },
        argument_sources: {
          states: "operations_by_id.recall.arguments_by_name.states"
        },
        retry_with: { argument: "states", value_placeholder: ["canonical"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ types: ["decision", 123] as never }), "Invalid types", "retry read with types as non-empty strings", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "types", value: ["decision", 123] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          types: "operations_by_id.recall.arguments_by_name.types"
        },
        retry_with: { argument: "types", value_placeholder: ["<type>"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ tags: "sync" as never }), "Invalid tags", "retry read with tags as non-empty strings", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "tags", value: "sync" },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          tags: "operations_by_id.recall.arguments_by_name.tags"
        },
        retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
      });
      await expectInvalidReadShapeArgument(() => engine.recall({ files: ["src/auth.ts", 123] as never }), "Invalid files", "retry read with files as non-empty strings", {
        operation_contract: "operations_by_id.recall",
        rejected_argument: { argument: "files", value: ["src/auth.ts", 123] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          files: "operations_by_id.recall.arguments_by_name.files"
        },
        retry_with: { argument: "files", value_placeholder: ["<file>"] }
      });

      await expectInvalidArgument(() => engine.timeline(null as never), "Invalid timeline input");
      await expectInvalidReadShapeArgument(() => engine.timeline({ record_id: "" }), "Invalid record_id", "retry read with a non-empty record_id", {
        operation_contract: "operations_by_id.timeline",
        rejected_argument: { argument: "record_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          record_id: "operations_by_id.timeline.arguments_by_name.record_id"
        },
        retry_with: { argument: "record_id", value_placeholder: "<record_id>" }
      });
      await expectInvalidReadShapeArgument(
        () => engine.timeline({ record_id: "rec_1", event_id: "evt_1" }),
        "timeline requires exactly one anchor",
        "retry timeline with exactly one of record_id, event_id, or query",
        {
          operation_contract: "operations_by_id.timeline",
          rejected_argument: { argument: "anchor", value: ["record_id", "event_id"] },
          expected: { kind: "one_of", allowed_arguments: ["record_id", "event_id", "query"] },
          argument_sources: {
            record_id: "operations_by_id.timeline.arguments_by_name.record_id",
            event_id: "operations_by_id.timeline.arguments_by_name.event_id",
            query: "operations_by_id.timeline.arguments_by_name.query"
          },
          retry_with: { argument: "record_id", value_placeholder: "<record_id>" }
        }
      );

      await expectInvalidArgument(() => engine.boot(null as never), "Invalid boot input");
      await expectInvalidReadShapeArgument(() => engine.boot({ default_skills: ["release", 123] as never }), "Invalid default_skills", "retry read with default_skills as non-empty strings", {
        operation_contract: "operations_by_id.boot",
        rejected_argument: { argument: "default_skills", value: ["release", 123] },
        expected: { kind: "array_of_non_empty_strings" },
        argument_sources: {
          default_skills: "operations_by_id.boot.arguments_by_name.default_skills"
        },
        retry_with: { argument: "default_skills", value_placeholder: ["<default_skill>"] }
      });
      await expectInvalidReadShapeArgument(() => engine.boot({ current_task: 123 as never }), "Invalid current_task", "retry read with a non-empty current_task", {
        operation_contract: "operations_by_id.boot",
        rejected_argument: { argument: "current_task", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          current_task: "operations_by_id.boot.arguments_by_name.current_task"
        },
        retry_with: { argument: "current_task", value_placeholder: "<current_task>" }
      });

      await expectInvalidArgument(() => engine.refresh(null as never), "Invalid refresh input");
      await expectInvalidReadShapeArgument(() => engine.refresh({ cursor: 123 as never }), "Invalid cursor", "retry read with a non-empty cursor", {
        operation_contract: "operations_by_id.refresh",
        rejected_argument: { argument: "cursor", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          cursor: "operations_by_id.refresh.arguments_by_name.cursor"
        },
        retry_with: { argument: "cursor", value_placeholder: "<cursor>" }
      });
      try {
        await engine.refresh({ cursor: "not-a-date" });
        throw new Error("Expected refresh to reject invalid cursor");
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        expect(envelope.error.code).toBe("INVALID_ARGUMENT");
        expect(envelope.error.message).toContain("Invalid cursor");
        expect(envelope.error.recommended_action).toBe("retry with a refresh cursor returned by Moryn");
        expect(envelope.error.recovery_hint).toEqual({
          operation_contract: "operations_by_id.refresh",
          rejected_argument: { argument: "cursor", value: "not-a-date" },
          expected: {
            kind: "iso_datetime",
            format: "RFC3339 timestamp with timezone",
            source: "refresh.cursor, boot.sync.cursor, agent_start.refresh.cursor, or agent_enter.start.refresh.cursor"
          },
          argument_sources: {
            cursor: "operations_by_id.refresh.arguments_by_name.cursor"
          },
          retry_with: {
            argument: "cursor",
            value_source: "previous Moryn response cursor field",
            value_placeholder: "<refresh cursor ISO datetime>"
          }
        });
      }
      await expectInvalidReadShapeArgument(() => engine.refresh({ current_task: 123 as never }), "Invalid current_task", "retry read with a non-empty current_task", {
        operation_contract: "operations_by_id.refresh",
        rejected_argument: { argument: "current_task", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          current_task: "operations_by_id.refresh.arguments_by_name.current_task"
        },
        retry_with: { argument: "current_task", value_placeholder: "<current_task>" }
      });

      await expectInvalidReadShapeArgument(() => engine.listProjects({ current_task: 123 as never }), "Invalid current_task", "retry read with a non-empty current_task", {
        operation_contract: "operations_by_id.project_list",
        rejected_argument: { argument: "current_task", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          current_task: "operations_by_id.project_list.arguments_by_name.current_task"
        },
        retry_with: { argument: "current_task", value_placeholder: "<current_task>" }
      });
      await expectInvalidReadShapeArgument(() => engine.listProjects({ sync_remote: 123 as never }), "Invalid sync_remote", "retry read with a non-empty sync_remote", {
        operation_contract: "operations_by_id.project_list",
        rejected_argument: { argument: "sync_remote", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          sync_remote: "operations_by_id.project_list.arguments_by_name.sync_remote"
        },
        retry_with: { argument: "sync_remote", value_placeholder: "<sync_remote>" }
      });
      await expectInvalidReadShapeArgument(() => engine.listProjects({ agent: { client: "" } }), "Invalid agent.client", "retry project_list with a valid agent client", {
        operation_contract: "operations_by_id.project_list",
        rejected_argument: { argument: "agent.client", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "agent.client": "operations_by_id.project_list.arguments_by_name.agent_client"
        },
        retry_with: { argument: "agent.client", value_placeholder: "<agent client>" }
      });
      await expectInvalidReadShapeArgument(
        () => engine.listProjects({ agent: { client: "codex", session_id: "" } }),
        "Invalid agent.session_id",
        "retry project_list with valid agent identity metadata",
        {
          operation_contract: "operations_by_id.project_list",
          rejected_argument: { argument: "agent.session_id", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          argument_sources: {
            "agent.session_id": "operations_by_id.project_list.arguments_by_name.agent_session_id"
          },
          retry_with: { argument: "agent.session_id", value_placeholder: "<agent session id>" }
        }
      );
    });
  });

  it("rejects mutation events that target missing records", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Existing memory.", format: "text" },
        source: { client: "test" }
      });

      await expect(engine.revise({
        record_id: "rec_missing",
        patch: { "content.text": "No-op" },
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.promote({
        record_id: "rec_missing",
        target_state: "canonical",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.archive({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.quarantine({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: "rec_missing",
        linked_record_id: existing.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: existing.record.id,
        linked_record_id: "rec_missing",
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.recall({
        record_ids: ["rec_missing"]
      })).rejects.toThrow("Record not found: rec_missing");

      const recall = await engine.recall({ record_ids: [existing.record.id] });
      expect(recall.results[0]?.record.links).toBeUndefined();
    });
  });

  it("rejects invalid core mutation arguments before appending events", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Existing memory.", format: "text" },
        source: { client: "test" }
      });
      const linked = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Linked memory.", format: "text" },
        source: { client: "test" }
      });
      const originalEvents = await readEvents(storePath);

      async function expectInvalidArgument(action: () => Promise<unknown>, message: string): Promise<void> {
        try {
          await action();
          throw new Error("Expected mutation to reject invalid input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
        }
        expect(await readEvents(storePath)).toHaveLength(originalEvents.length);
      }

      async function expectInvalidMutationShapeArgument(
        action: () => Promise<unknown>,
        message: string,
        recommendedAction: string,
        recoveryHint: unknown
      ): Promise<void> {
        try {
          await action();
          throw new Error("Expected mutation to reject invalid shape input");
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(message);
          expect(envelope.error.recommended_action).toBe(recommendedAction);
          expect(envelope.error.recovery_hint).toEqual(recoveryHint);
        }
        expect(await readEvents(storePath)).toHaveLength(originalEvents.length);
      }

      await expectInvalidArgument(() => engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Project records need an explicit project id.", format: "text" },
        source: { client: "test" }
      }), "project_id is required for project scope");
      await expectInvalidArgument(() => engine.revise(null as never), "Invalid revise input");
      await expectInvalidMutationShapeArgument(() => engine.revise({
        record_id: "",
        patch: { "content.text": "No-op" },
        source: { client: "test" }
      }), "Invalid record_id", "retry mutation with a valid record_id", {
        operation_contract: "operations_by_id.revise",
        rejected_argument: { argument: "record_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          record_id: "operations_by_id.revise.arguments_by_name.record_id"
        },
        retry_with: { argument: "record_id", value_placeholder: "<record_id>" }
      });
      await expectInvalidArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: [] as never,
        source: { client: "test" }
      }), "Invalid patch");
      await expectInvalidArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: {},
        source: { client: "test" }
      }), "Invalid patch");
      for (const patch of [
        { "": "No-op" },
        { ".content.text": "No-op" },
        { "content..text": "No-op" },
        { "content.text.": "No-op" }
      ]) {
        await expectInvalidArgument(() => engine.revise({
          record_id: existing.record.id,
          patch,
          source: { client: "test" }
        }), "Invalid patch");
      }
      await expectInvalidMutationShapeArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: { "content.text": "No-op" },
        source: { client: "" }
      }), "Invalid source.client", "retry mutation with a valid source client", {
        operation_contract: "operations_by_id.revise",
        rejected_argument: { argument: "source.client", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "source.client": "operations_by_id.revise.arguments_by_name.source_client"
        },
        retry_with: { argument: "source.client", value_placeholder: "<client>" }
      });
      await expectInvalidMutationShapeArgument(() => engine.revise({
        record_id: existing.record.id,
        patch: { "content.text": "No-op" },
        reason: "",
        source: { client: "test" }
      }), "Invalid reason", "retry mutation with a non-empty reason", {
        operation_contract: "operations_by_id.revise",
        rejected_argument: { argument: "reason", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          reason: "operations_by_id.revise.arguments_by_name.reason"
        },
        retry_with: { argument: "reason", value_placeholder: "<reason>" }
      });

      await expectInvalidArgument(() => engine.promote(null as never), "Invalid promote input");
      await expectInvalidMutationShapeArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "published" as never,
        source: { client: "test" }
      }), "Invalid target_state", "retry mutation with a supported target_state", {
        operation_contract: "operations_by_id.promote",
        rejected_argument: { argument: "target_state", value: "published" },
        expected: { kind: "allowed_values", allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"] },
        argument_sources: {
          target_state: "operations_by_id.promote.arguments_by_name.target_state"
        },
        retry_with: { argument: "target_state", value_placeholder: "canonical" }
      });
      await expectInvalidMutationShapeArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "canonical",
        confirmed: "yes" as never,
        source: { client: "test" }
      }), "Invalid confirmed", "retry mutation with a boolean confirmed value", {
        operation_contract: "operations_by_id.promote",
        rejected_argument: { argument: "confirmed", value: "yes" },
        expected: { kind: "boolean" },
        argument_sources: {
          confirmed: "operations_by_id.promote.arguments_by_name.confirmed"
        },
        retry_with: { argument: "confirmed", value_placeholder: true }
      });
      await expectInvalidMutationShapeArgument(() => engine.promote({
        record_id: existing.record.id,
        target_state: "canonical",
        reason: "",
        source: { client: "test" }
      }), "Invalid reason", "retry mutation with a non-empty reason", {
        operation_contract: "operations_by_id.promote",
        rejected_argument: { argument: "reason", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          reason: "operations_by_id.promote.arguments_by_name.reason"
        },
        retry_with: { argument: "reason", value_placeholder: "<reason>" }
      });

      await expectInvalidArgument(() => engine.archive(null as never), "Invalid archive input");
      await expectInvalidMutationShapeArgument(() => engine.archive({
        record_id: "",
        source: { client: "test" }
      }), "Invalid record_id", "retry mutation with a valid record_id", {
        operation_contract: "operations_by_id.archive",
        rejected_argument: { argument: "record_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          record_id: "operations_by_id.archive.arguments_by_name.record_id"
        },
        retry_with: { argument: "record_id", value_placeholder: "<record_id>" }
      });
      await expectInvalidMutationShapeArgument(() => engine.archive({
        record_id: existing.record.id,
        reason: "",
        source: { client: "test" }
      }), "Invalid reason", "retry mutation with a non-empty reason", {
        operation_contract: "operations_by_id.archive",
        rejected_argument: { argument: "reason", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          reason: "operations_by_id.archive.arguments_by_name.reason"
        },
        retry_with: { argument: "reason", value_placeholder: "<reason>" }
      });
      await expectInvalidArgument(() => engine.quarantine(null as never), "Invalid quarantine input");
      await expectInvalidMutationShapeArgument(() => engine.quarantine({
        record_id: existing.record.id,
        reason: 123 as never,
        source: { client: "test" }
      }), "Invalid reason", "retry mutation with a non-empty reason", {
        operation_contract: "operations_by_id.quarantine",
        rejected_argument: { argument: "reason", value: 123 },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          reason: "operations_by_id.quarantine.arguments_by_name.reason"
        },
        retry_with: { argument: "reason", value_placeholder: "<reason>" }
      });
      await expectInvalidMutationShapeArgument(() => engine.quarantine({
        record_id: existing.record.id,
        reason: "",
        source: { client: "test" }
      }), "Invalid reason", "retry mutation with a non-empty reason", {
        operation_contract: "operations_by_id.quarantine",
        rejected_argument: { argument: "reason", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          reason: "operations_by_id.quarantine.arguments_by_name.reason"
        },
        retry_with: { argument: "reason", value_placeholder: "<reason>" }
      });

      await expectInvalidMutationShapeArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: "",
        link_type: "supersedes",
        source: { client: "test" }
      }), "Invalid linked_record_id", "retry mutation with a valid linked_record_id", {
        operation_contract: "operations_by_id.link",
        rejected_argument: { argument: "linked_record_id", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          linked_record_id: "operations_by_id.link.arguments_by_name.linked_record_id"
        },
        retry_with: { argument: "linked_record_id", value_placeholder: "<linked_record_id>" }
      });
      await expectInvalidMutationShapeArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: linked.record.id,
        link_type: "",
        source: { client: "test" }
      }), "Invalid link_type", "retry link with a non-empty link_type", {
        operation_contract: "operations_by_id.link",
        rejected_argument: { argument: "link_type", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          link_type: "operations_by_id.link.arguments_by_name.link_type"
        },
        retry_with: { argument: "link_type", value_placeholder: "<link_type>" }
      });
      await expectInvalidMutationShapeArgument(() => engine.link({
        record_id: existing.record.id,
        linked_record_id: linked.record.id,
        link_type: "supersedes",
        source: { client: "" }
      }), "Invalid source.client", "retry mutation with a valid source client", {
        operation_contract: "operations_by_id.link",
        rejected_argument: { argument: "source.client", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          "source.client": "operations_by_id.link.arguments_by_name.source_client"
        },
        retry_with: { argument: "source.client", value_placeholder: "<client>" }
      });
    });
  });
});
