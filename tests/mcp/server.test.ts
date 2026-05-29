import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/store.js";
import { initializeProjectConfig } from "../../src/core/project.js";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");
const cliPath = join(repoRoot, "src/cli.ts");
const LIST_PROJECTS_WHEN = "When the shared store has projects but this agent has no explicit project context.";
const FIX_PROJECT_CONFIG_WHEN = "Before starting lifecycle work when project context is invalid or missing.";
const INSPECT_SYNC_CONFLICT_WHEN = "Before retrying lifecycle writes or sync operations after a Git conflict.";
const NEXT_ACTION_SELECTION_SOURCES = {
  error_next_action: "error.next_action",
  warning_next_action: "warning.next_action",
  error_required_field: "error.next_action.required_fields_by_name.<field>",
  warning_required_field: "warning.next_action.required_fields_by_name.<field>",
  error_argument_source: "error.next_action.argument_sources.<field>",
  warning_argument_source: "warning.next_action.argument_sources.<field>",
  error_workflow_phase: "error.next_action.workflow.phases_by_name.<phase>",
  warning_workflow_phase: "warning.next_action.workflow.phases_by_name.<phase>"
};
const LIFECYCLE_ACTION_SELECTION_SOURCES = {
  action: "next.actions_by_id.<action>",
  action_id: "next.actions_by_id.<action>.action",
  ordered_action: "next.actions[]"
};
const GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES = {
  lifecycle_action: "lifecycle_by_step.<step>",
  step: "lifecycle_by_step.<step>.step",
  ordered_lifecycle_action: "lifecycle[]"
};
const GUIDE_ENTRYPOINT_SELECTION_SOURCES = {
  startup_action: "startup",
  next_action: "next",
  workflow_phase: "workflow.phases_by_name.start_or_resume"
};
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
const REBUILD_SELECTION_SOURCES = {
  record_count: "records",
  project_ids: "projects",
  skill_count: "skills",
  artifacts: "artifacts",
  user_snapshot: "artifacts.snapshots.user",
  project_snapshots: "artifacts.snapshots.projects_by_id",
  skills_snapshot: "artifacts.snapshots.skills",
  recall_index: "artifacts.indexes.recall",
  sync_cursors_index: "artifacts.indexes.sync_cursors"
};

function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(workflow: TWorkflow) {
  return {
    ...workflow,
    phases_by_name: Object.fromEntries(workflow.phases.map((phase) => [phase.phase, phase]))
  };
}

function singleNextWorkflow(input: {
  recommendedAction: string;
  tool: string;
  requiredWhen: string;
  requiredFields?: string[];
}) {
  return {
    version: 1,
    start: "next",
    continue_from: ["next"],
    phases: [
      {
        phase: input.recommendedAction,
        order: 1,
        action_source: "next",
        tool: input.tool,
        required_when: input.requiredWhen,
        required_fields: input.requiredFields ?? []
      }
    ]
  };
}

function expectActionInterfaces(action: {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  interfaces?: {
    cli?: { command?: string };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
}) {
  expect(action.interfaces?.cli).toEqual({ command: action.command });
  expect(action.interfaces?.mcp).toEqual({
    tool: action.tool,
    arguments: action.arguments
  });
}

function expectNextActionSelectionSources(action: {
  selection_sources?: Record<string, string>;
}) {
  expect(action.selection_sources).toEqual(NEXT_ACTION_SELECTION_SOURCES);
}

function expectLifecycleActionSelectionSources(action: {
  selection_sources?: Record<string, string>;
}) {
  expect(action.selection_sources).toEqual(LIFECYCLE_ACTION_SELECTION_SOURCES);
}

function expectGuideLifecycleStepSelectionSources(action: {
  selection_sources?: Record<string, string>;
}) {
  expect(action.selection_sources).toEqual(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES);
}

function expectGuideEntrypointSelectionSources(action: {
  selection_sources?: Record<string, string>;
}) {
  expect(action.selection_sources).toEqual(GUIDE_ENTRYPOINT_SELECTION_SOURCES);
}

function expectRecoveryWorkflow(action: {
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

function expectLifecycleWorkflow(action: {
  step: string;
  tool: string;
  required_when: string;
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
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "lifecycle_by_step",
    continue_from: ["lifecycle_by_step", "lifecycle"],
    phases: [
      {
        phase: action.step,
        order: 1,
        action_source: `lifecycle_by_step.${action.step}`,
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectGuideEntrypointWorkflow(action: {
  tool: string;
  required_when: string;
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
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "startup",
    continue_from: ["startup"],
    phases: [
      {
        phase: "call_agent_enter",
        order: 1,
        action_source: "startup",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectGuideNextWorkflow(action: {
  tool: string;
  required_when: string;
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
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next",
    continue_from: ["next"],
    phases: [
      {
        phase: "call_agent_enter",
        order: 1,
        action_source: "next",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectProjectListNextWorkflow(action: {
  recommended_action: string;
  tool: string;
  required_when: string;
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
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next",
    continue_from: ["project_list.projects_by_id.<project_id>.next", "project_list.projects[].next"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "project_list.projects_by_id.<project_id>.next",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
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

function expectRefreshChangeNextAction(action: {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
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
      ordered_next_action: "refresh.changes[].next_action"
    }
  });
  expectActionInterfaces(action);
  expectActionSafety(action);
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

function expectHandoffEntryNextAction(action: {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
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
}, recordId: string, projectId: string, source: "inbox" | "active_sessions" = "inbox") {
  const actionSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.next_action"
    : "handoff.active_sessions_by_record_id.<record_id>.next_action";
  const recordIdSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.record_id"
    : "handoff.active_sessions_by_record_id.<record_id>.record_id";
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
    tool: "recall",
    safe_to_run: true,
    required_when: "After reading this handoff entry and needing the full session record.",
    required_fields: [],
    command: `moryn recall --record-id ${recordId} --project-id ${projectId}`,
    arguments: {
      record_ids: [recordId],
      project_id: projectId
    },
    argument_sources: {
      record_ids: recordIdSource
    },
    selection_sources: {
      entry: source === "inbox"
        ? "handoff.inbox_by_record_id.<record_id>"
        : "handoff.active_sessions_by_record_id.<record_id>",
      record_id: recordIdSource,
      next_action: actionSource,
      ordered_next_action: source === "inbox"
        ? "handoff.inbox[].next_action"
        : "handoff.active_sessions[].next_action"
    }
  });
  expectActionInterfaces(action);
  expectActionSafety(action);
  expect(action.safety?.reasons).toEqual(["safe_read_or_status_check"]);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: [
      "handoff.inbox_by_record_id.<record_id>.next_action",
      "handoff.active_sessions_by_record_id.<record_id>.next_action",
      "handoff.inbox[].next_action",
      "handoff.active_sessions[].next_action"
    ],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: actionSource,
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>, cwd = repoRoot): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", tsxLoader, cliPath, "--store", storePath, "mcp"],
    cwd,
    stderr: "pipe"
  });
  const client = new Client({ name: "moryn-test-client", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function createMcpSyncConflict(input: {
  remote: string;
  storeA: string;
  storeB: string;
  conflictFile: string;
}): Promise<void> {
  await withMcpClient(input.storeA, async (agentA) => {
    await withMcpClient(input.storeB, async (agentB) => {
      expect((parseTextContent(await agentA.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
      expect((parseTextContent(await agentB.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
      expect((parseTextContent(await agentA.callTool({ name: "sync_init", arguments: { remote: input.remote } })) as { ok: boolean }).ok).toBe(true);
      expect((parseTextContent(await agentB.callTool({ name: "sync_init", arguments: { remote: input.remote } })) as { ok: boolean }).ok).toBe(true);
    });
  });
  await mkdir(join(input.storeA, "events", "shared-device", "2026-05"), { recursive: true });
  await mkdir(join(input.storeB, "events", "shared-device", "2026-05"), { recursive: true });
  await writeFile(join(input.storeA, input.conflictFile), "{\"from\":\"a\"}\n", "utf8");
  await writeFile(join(input.storeB, input.conflictFile), "{\"from\":\"b\"}\n", "utf8");
  await exec("git", ["add", input.conflictFile], { cwd: input.storeA });
  await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: input.storeA });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: input.storeA });
  await exec("git", ["add", input.conflictFile], { cwd: input.storeB });
  await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: input.storeB });
  await withMcpClient(input.storeB, async (agentB) => {
    const response = await agentB.callTool({ name: "sync_pull", arguments: {} });
    expect("isError" in response ? response.isError : false).toBe(true);
    expect((parseTextContent(response) as { error: { code: string } }).error.code).toBe("SYNC_CONFLICT");
  });
}

function parseTextContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const first = "content" in result ? result.content[0] : undefined;
  if (!first || first.type !== "text") {
    throw new Error("Expected a text MCP tool response");
  }
  return JSON.parse(first.text);
}

async function expectInvalidMcpArguments(action: () => Promise<Awaited<ReturnType<Client["callTool"]>>>, expectedMessage: RegExp): Promise<void> {
  const result = await action();
  expect("isError" in result ? result.isError : false).toBe(true);
  const first = "content" in result ? result.content[0] : undefined;
  expect(first?.type).toBe("text");
  if (!first || first.type !== "text") {
    throw new Error("Expected a text MCP validation error");
  }
  expect(first.text).toMatch(expectedMessage);
}

describe("MCP stdio server", () => {
  it("returns machine-readable agent guide through MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-guide-"));
    try {
      await withMcpClient(store, async (client) => {
        const guide = parseTextContent(await client.callTool({
          name: "agent_guide",
          arguments: {
            project_path: "/workspace/moryn",
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "continue MCP handoff",
            agent: { client: "gemini", session_id: "gemini-mcp-guide" }
          }
        })) as {
          ok: boolean;
          recommended_entrypoint: string;
          selection_sources: Record<string, string>;
          startup: {
            tool: string;
            command: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            arguments: {
              project_path?: string;
              sync_remote?: string;
              current_task?: string;
              agent?: { client: string; session_id?: string };
            };
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
            selection_sources?: Record<string, string>;
            workflow?: Record<string, unknown>;
          };
          lifecycle: Array<{
            step: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            required_fields_by_name?: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            arguments: Record<string, unknown>;
            selection_sources?: Record<string, string>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          }>;
          lifecycle_by_step: Record<string, {
            step: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            required_fields_by_name?: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            arguments: Record<string, unknown>;
            selection_sources?: Record<string, string>;
          }>;
          rules: string[];
          rules_by_id: Record<string, {
            id: string;
            text: string;
          }>;
          guardrails: Array<{
            id: string;
            when: string;
            risk: string;
            avoid: string[];
            required_behavior: string;
            use_instead?: {
              recommended_action: string;
              tool: string;
              command: string;
              safe_to_run: boolean;
              required_when: string;
              required_fields: string[];
              arguments: Record<string, unknown>;
              interfaces?: {
                cli?: { command?: string };
                mcp?: { tool?: string; arguments?: Record<string, unknown> };
              };
            };
            allowed_action_sources?: string[];
          }>;
          guardrails_by_id: Record<string, {
            id: string;
            when: string;
            risk: string;
            avoid: string[];
            required_behavior: string;
            use_instead?: {
              recommended_action: string;
              tool: string;
              command: string;
              safe_to_run: boolean;
              required_when: string;
              required_fields: string[];
              arguments: Record<string, unknown>;
            };
            allowed_action_sources?: string[];
          }>;
          workflow: {
            version: number;
            start: string;
            continue_from: string[];
            phases: Array<{
              phase: string;
              order: number;
              action_source: string;
              tool?: string;
              required_when: string;
              required_fields: string[];
            }>;
            phases_by_name: Record<string, {
              phase: string;
              order: number;
              action_source: string;
              tool?: string;
              required_when: string;
              required_fields: string[];
            }>;
          };
          next: {
            recommended_action: string;
            tool: string;
            command: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
            selection_sources?: Record<string, string>;
            workflow?: Record<string, unknown>;
          };
        };

        expect(guide.ok).toBe(true);
        expect(guide.recommended_entrypoint).toBe("agent_enter");
        expect(guide.selection_sources).toEqual({
          startup: "startup",
          lifecycle_action: "lifecycle_by_step.<step>",
          rule: "rules_by_id.<rule_id>",
          guardrail: "guardrails_by_id.<guardrail_id>"
        });
        expect(guide.startup).toMatchObject({
          tool: "agent_enter",
          command: "moryn agent enter --project /workspace/moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue MCP handoff' --agent gemini --session-id gemini-mcp-guide",
          safe_to_run: true,
          required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
          required_fields: [],
          arguments: {
            project_path: "/workspace/moryn",
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "continue MCP handoff",
            agent: { client: "gemini", session_id: "gemini-mcp-guide" }
          }
        });
        expectActionInterfaces(guide.startup);
        expectGuideEntrypointSelectionSources(guide.startup);
        expectGuideEntrypointWorkflow(guide.startup);
        expect(guide.lifecycle.map((step) => step.tool)).toEqual([
          "agent_enter",
          "agent_status",
          "agent_finish",
          "agent_start"
        ]);
        expect(guide.lifecycle_by_step.start_or_resume).toEqual(guide.lifecycle[0]);
        expect(guide.lifecycle_by_step.publish_status).toEqual(guide.lifecycle.find((step) => step.step === "publish_status"));
        expect(guide.lifecycle_by_step.finish_handoff).toEqual(guide.lifecycle.find((step) => step.step === "finish_handoff"));
        expect(guide.lifecycle_by_step.refresh_context).toEqual(guide.lifecycle.find((step) => step.step === "refresh_context"));
        expect(guide.startup.required_fields_by_name).toEqual({});
        expect(guide.lifecycle_by_step.publish_status.required_fields_by_name?.status).toEqual({
          name: "status",
          argument_path: "status",
          placeholder: "<status>",
          value: "<status>"
        });
        expect(guide.lifecycle_by_step.finish_handoff.required_fields_by_name?.summary).toEqual({
          name: "summary",
          argument_path: "summary",
          placeholder: "<summary>",
          value: "<summary>"
        });
        expect(guide.lifecycle_by_step.refresh_context.required_fields_by_name?.refresh_since).toEqual({
          name: "refresh_since",
          argument_path: "refresh_since",
          placeholder: "<refresh_since>",
          value: "<refresh_since>"
        });
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "publish_status",
          tool: "agent_status",
          safe_to_run: false,
          required_fields: ["status"],
          argument_sources: {
            status: "user_input.status"
          },
          arguments: expect.objectContaining({ status: "<status>" })
        }));
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "finish_handoff",
          tool: "agent_finish",
          safe_to_run: false,
          required_fields: ["summary"],
          argument_sources: {
            summary: "user_input.summary"
          },
          arguments: expect.objectContaining({ summary: "<summary>" })
        }));
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "refresh_context",
          tool: "agent_start",
          safe_to_run: true,
          command: "moryn agent start --project /workspace/moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue MCP handoff' --agent gemini --session-id gemini-mcp-guide --refresh-since <refresh_since>",
          required_fields: ["refresh_since"],
          argument_sources: {
            refresh_since: "user_input.refresh_since"
          }
        }));
        for (const action of guide.lifecycle) {
          expectActionInterfaces(action);
          expectLifecycleWorkflow(action);
          expectGuideLifecycleStepSelectionSources(action);
        }
        expectGuideLifecycleStepSelectionSources(guide.lifecycle_by_step.publish_status);
        expectGuideLifecycleStepSelectionSources(guide.lifecycle_by_step.finish_handoff);
        expectGuideLifecycleStepSelectionSources(guide.lifecycle_by_step.refresh_context);
        expect(guide.rules).toContain("Prefer agent_enter for startup; do not manually compose sync_pull, boot, and refresh.");
        expect(guide.rules).toContain("When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id.");
        expect(Object.keys(guide.rules_by_id)).toEqual([
          "prefer_agent_enter_for_startup",
          "discover_project_before_lifecycle_writes",
          "use_returned_actions_verbatim",
          "publish_status_and_finish_handoff",
          "pass_sync_remote_for_cross_device_handoff"
        ]);
        expect(guide.rules_by_id.prefer_agent_enter_for_startup).toEqual({
          id: "prefer_agent_enter_for_startup",
          text: "Prefer agent_enter for startup; do not manually compose sync_pull, boot, and refresh."
        });
        expect(guide.rules_by_id.discover_project_before_lifecycle_writes).toEqual({
          id: "discover_project_before_lifecycle_writes",
          text: "When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id."
        });
        expect(guide.rules_by_id.use_returned_actions_verbatim.text).toBe("Use returned next.actions commands or arguments verbatim when continuing the lifecycle.");
        expect(guide.rules).toEqual(Object.values(guide.rules_by_id).map((rule) => rule.text));
        expect(guide.guardrails.map((guardrail) => guardrail.id)).toEqual([
          "prefer_agent_enter_for_startup",
          "discover_project_before_lifecycle_writes",
          "use_returned_actions_verbatim",
          "publish_status_and_finish_handoff",
          "pass_sync_remote_for_cross_device_handoff"
        ]);
        expect(guide.guardrails_by_id.prefer_agent_enter_for_startup).toEqual(guide.guardrails[0]);
        expect(guide.guardrails_by_id.discover_project_before_lifecycle_writes).toEqual(guide.guardrails.find((guardrail) => guardrail.id === "discover_project_before_lifecycle_writes"));
        expect(guide.guardrails_by_id.use_returned_actions_verbatim).toEqual(guide.guardrails.find((guardrail) => guardrail.id === "use_returned_actions_verbatim"));
        expect(guide.guardrails_by_id.publish_status_and_finish_handoff).toEqual(guide.guardrails.find((guardrail) => guardrail.id === "publish_status_and_finish_handoff"));
        expect(guide.guardrails_by_id.pass_sync_remote_for_cross_device_handoff).toEqual(guide.guardrails.find((guardrail) => guardrail.id === "pass_sync_remote_for_cross_device_handoff"));
        expect(guide.guardrails).toContainEqual(expect.objectContaining({
          id: "prefer_agent_enter_for_startup",
          when: guide.startup.required_when,
          avoid: ["manual_sync_pull_boot_refresh", "manual_lower_level_startup_sequence"],
          required_behavior: "Call the returned agent_enter startup action instead of composing lower-level startup tools.",
          use_instead: {
            recommended_action: "call_agent_enter",
            ...guide.startup
          }
        }));
        expect(guide.guardrails).toContainEqual(expect.objectContaining({
          id: "use_returned_actions_verbatim",
          avoid: ["reconstruct_command_from_memory", "rename_argument_fields", "drop_required_fields"],
          allowed_action_sources: ["startup", "next", "lifecycle_by_step", "lifecycle", "response.next.actions"]
        }));
        expect(guide.workflow).toMatchObject({
          version: 1,
          start: "startup",
          continue_from: ["agent_enter.next.actions", "lifecycle_by_step", "lifecycle"]
        });
        expect(guide.workflow.phases).toEqual([
          {
            phase: "start_or_resume",
            order: 1,
            action_source: "startup",
            tool: "agent_enter",
            required_when: guide.startup.required_when,
            required_fields: []
          },
          {
            phase: "follow_returned_next_actions",
            order: 2,
            action_source: "agent_enter.next.actions",
            required_when: "After agent_enter returns, prefer its response.next.actions over static guide templates.",
            required_fields: []
          },
          {
            phase: "publish_status",
            order: 3,
            action_source: "lifecycle_by_step.publish_status",
            tool: "agent_status",
            required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
            required_fields: ["status"]
          },
          {
            phase: "finish_handoff",
            order: 4,
            action_source: "lifecycle_by_step.finish_handoff",
            tool: "agent_finish",
            required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
            required_fields: ["summary"]
          },
          {
            phase: "refresh_context",
            order: 5,
            action_source: "lifecycle_by_step.refresh_context",
            tool: "agent_start",
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: ["refresh_since"]
          }
        ]);
        expect(guide.workflow.phases_by_name.publish_status).toEqual(guide.workflow.phases.find((phase) => phase.phase === "publish_status"));
        expect(guide.workflow.phases_by_name.finish_handoff).toEqual(guide.workflow.phases.find((phase) => phase.phase === "finish_handoff"));
        expect(guide.next).toMatchObject({
          recommended_action: "call_agent_enter",
          tool: "agent_enter",
          command: guide.startup.command,
          safe_to_run: true,
          required_when: guide.startup.required_when,
          required_fields: [],
          arguments: guide.startup.arguments
        });
        expectActionInterfaces(guide.next);
        expectGuideEntrypointSelectionSources(guide.next);
        expectGuideNextWorkflow(guide.next);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit project id in MCP agent guide lifecycle templates when project is unknown", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-guide-discovery-"));
    try {
      await withMcpClient(store, async (client) => {
        const guide = parseTextContent(await client.callTool({
          name: "agent_guide",
          arguments: {
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "find MCP project",
            agent: { client: "gemini", session_id: "gemini-mcp-guide-discovery" }
          }
        })) as {
          startup: { command: string; safe_to_run: boolean; required_when: string; required_fields: string[]; arguments: { project_id?: string } };
          guardrails: Array<{
            id: string;
            required_behavior: string;
            use_instead?: { command: string; arguments: { project_id?: string } };
          }>;
          guardrails_by_id: Record<string, {
            id: string;
            required_behavior: string;
            use_instead?: { command: string; arguments: { project_id?: string } };
          }>;
          rules_by_id: Record<string, {
            id: string;
            text: string;
          }>;
          workflow: {
            start: string;
            phases: Array<{
              phase: string;
              action_source: string;
              required_fields: string[];
            }>;
          };
          lifecycle: Array<{
            step: string;
            tool: string;
            command: string;
            required_fields: string[];
            arguments: { project_id?: string; status?: string; summary?: string; refresh_since?: string };
          }>;
          lifecycle_by_step: Record<string, {
            step: string;
            tool: string;
            command: string;
            required_fields: string[];
            arguments: { project_id?: string; status?: string; summary?: string; refresh_since?: string };
          }>;
        };

        expect(guide.startup.command).toBe("moryn agent enter --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-guide-discovery");
        expect(guide.startup.safe_to_run).toBe(true);
        expect(guide.startup.required_when).toBe("At the start of an agent turn, or whenever store/project/sync context is uncertain.");
        expect(guide.startup.required_fields).toEqual([]);
        expect(guide.startup.arguments.project_id).toBeUndefined();
        expect(guide.guardrails).toContainEqual(expect.objectContaining({
          id: "discover_project_before_lifecycle_writes",
          required_behavior: "When project context is unclear, call agent_enter discovery and choose a returned project before lifecycle writes.",
          use_instead: expect.objectContaining({
            command: guide.startup.command,
            arguments: guide.startup.arguments
          })
        }));
        expect(guide.guardrails_by_id.discover_project_before_lifecycle_writes).toEqual(guide.guardrails.find((guardrail) => guardrail.id === "discover_project_before_lifecycle_writes"));
        expect(guide.rules_by_id.discover_project_before_lifecycle_writes).toEqual({
          id: "discover_project_before_lifecycle_writes",
          text: "When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id."
        });
        expect(guide.workflow.start).toBe("startup");
        expect(guide.workflow.phases).toContainEqual(expect.objectContaining({
          phase: "publish_status",
          action_source: "lifecycle_by_step.publish_status",
          required_fields: ["project_id", "status"]
        }));
        expect(guide.workflow.phases).toContainEqual(expect.objectContaining({
          phase: "finish_handoff",
          action_source: "lifecycle_by_step.finish_handoff",
          required_fields: ["project_id", "summary"]
        }));
        expect(guide.workflow.phases).toContainEqual(expect.objectContaining({
          phase: "refresh_context",
          action_source: "lifecycle_by_step.refresh_context",
          required_fields: ["project_id", "refresh_since"]
        }));
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "publish_status",
          tool: "agent_status",
          command: "moryn agent status --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-guide-discovery --status <status>",
          required_fields: ["project_id", "status"],
          arguments: expect.objectContaining({ project_id: "<project_id>", status: "<status>" })
        }));
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "finish_handoff",
          tool: "agent_finish",
          command: "moryn agent finish --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-guide-discovery --summary <summary>",
          required_fields: ["project_id", "summary"],
          arguments: expect.objectContaining({ project_id: "<project_id>", summary: "<summary>" })
        }));
        expect(guide.lifecycle).toContainEqual(expect.objectContaining({
          step: "refresh_context",
          tool: "agent_start",
          command: "moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-guide-discovery --refresh-since <refresh_since>",
          required_fields: ["project_id", "refresh_since"],
          arguments: expect.objectContaining({ project_id: "<project_id>", refresh_since: "<refresh_since>" })
        }));
        expect(guide.lifecycle_by_step.publish_status).toEqual(guide.lifecycle.find((step) => step.step === "publish_status"));
        expect(guide.lifecycle_by_step.finish_handoff).toEqual(guide.lifecycle.find((step) => step.step === "finish_handoff"));
        expect(guide.lifecycle_by_step.refresh_context).toEqual(guide.lifecycle.find((step) => step.step === "refresh_context"));
        for (const action of guide.lifecycle) {
          expectLifecycleWorkflow(action);
        }
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("exposes Moryn tools over the official MCP protocol", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-"));
    try {
      await withMcpClient(store, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "agent_doctor",
          "agent_enter",
          "agent_finish",
          "agent_guide",
          "agent_start",
          "agent_status",
          "archive",
          "boot",
          "init",
          "link",
          "list_recent",
          "project_init",
          "project_list",
          "promote",
          "quarantine",
          "rebuild",
          "recall",
          "refresh",
          "revise",
          "sync_init",
          "sync_pull",
          "sync_push",
          "sync_status",
          "write"
        ]);

        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const writeResult = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Use real MCP tools.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const recallResult = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { query: "real MCP", project_id: "moryn", limit: 5 }
        })) as {
          results: Array<{ record: { id: string; content: { text: string } } }>;
          results_by_id: Record<string, { record: { id: string; content: { text: string } } }>;
          selection_sources: Record<string, string>;
        };

        expect(recallResult.results[0]?.record.id).toBe(writeResult.record.id);
        expect(recallResult.results[0]?.record.content.text).toBe("Use real MCP tools.");
        expect(recallResult.selection_sources).toEqual({
          result: "results_by_id.<record_id>",
          record: "results_by_id.<record_id>.record",
          record_id: "results_by_id.<record_id>.record.id"
        });
        expect(recallResult.results_by_id[writeResult.record.id]).toEqual(recallResult.results[0]);

        const bootResult = parseTextContent(await client.callTool({
          name: "boot",
          arguments: { project_id: "moryn" }
        })) as {
          project: {
            important_decisions: Array<{ id: string; content: { text: string } }>;
            important_decisions_by_id: Record<string, { id: string; content: { text: string } }>;
          };
          records_by_id: Record<string, { id: string; content: { text: string } }>;
          selection_sources: Record<string, string>;
        };

        expect(bootResult.selection_sources).toEqual({
          record: "records_by_id.<record_id>",
          record_id: "records_by_id.<record_id>.id",
          user_preference: "profile.user_preferences_by_id.<record_id>",
          soul: "profile.soul_by_id.<record_id>",
          global_rule: "profile.global_rules_by_id.<record_id>",
          important_decision: "project.important_decisions_by_id.<record_id>",
          warning: "project.warnings_by_id.<record_id>",
          skill: "skills_by_id.<record_id>",
          task_relevant: "task_relevant_by_id.<record_id>",
          recent_change: "recent_changes_by_id.<record_id>"
        });
        expect(bootResult.project.important_decisions[0]?.id).toBe(writeResult.record.id);
        expect(bootResult.project.important_decisions_by_id[writeResult.record.id]).toEqual(bootResult.project.important_decisions[0]);
        expect(bootResult.records_by_id[writeResult.record.id]).toEqual(bootResult.project.important_decisions[0]);

        parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: writeResult.record.id,
            patch: { "content.text": "Use official MCP tools." },
            reason: "Prefer official protocol wording",
            source: { client: "mcp-test" }
          }
        }));

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: writeResult.record.id,
            target_state: "canonical",
            reason: "Verified through MCP",
            source: { client: "mcp-test" }
          }
        }));

        const recentResult = parseTextContent(await client.callTool({
          name: "list_recent",
          arguments: { limit: 1 }
        })) as {
          records: Array<{ id: string; state: string; content: { text: string } }>;
          records_by_id: Record<string, { id: string; state: string; content: { text: string } }>;
          selection_sources: Record<string, string>;
        };

        expect(recentResult.records[0]?.id).toBe(writeResult.record.id);
        expect(recentResult.selection_sources).toEqual({
          record: "records_by_id.<record_id>",
          record_id: "records_by_id.<record_id>.id"
        });
        expect(recentResult.records[0]?.state).toBe("canonical");
        expect(recentResult.records[0]?.content.text).toBe("Use official MCP tools.");
        expect(recentResult.records_by_id[writeResult.record.id]).toEqual(recentResult.records[0]);

        const refreshResult = parseTextContent(await client.callTool({
          name: "refresh",
          arguments: {
            project_id: "moryn",
            cursor: "2000-01-01T00:00:00.000Z",
            current_task: "real MCP"
          }
        })) as {
          changes: Array<{
            record_id: string;
            importance: string;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
              required_when: string;
              required_fields: string[];
            };
          }>;
          changes_by_record_id: Record<string, {
            record_id: string;
            importance: string;
            next_action: {
              workflow?: Record<string, unknown>;
            };
          }>;
          selection_sources: Record<string, string>;
        };

        expect(refreshResult.selection_sources).toEqual({
          change: "changes_by_record_id.<record_id>",
          record_id: "changes_by_record_id.<record_id>.record_id",
          next_action: "changes_by_record_id.<record_id>.next_action"
        });
        expect(refreshResult.changes).toEqual([
          expect.objectContaining({
            record_id: writeResult.record.id,
            importance: "notice",
            next_action: expect.any(Object)
          })
        ]);
        expect(refreshResult.changes_by_record_id[writeResult.record.id]).toEqual(refreshResult.changes[0]);
        expectRefreshChangeNextAction(refreshResult.changes[0]!.next_action, writeResult.record.id, "moryn");
        expect(refreshResult.changes_by_record_id[writeResult.record.id]!.next_action.workflow).toEqual(refreshResult.changes[0]!.next_action.workflow);

        const globalPreference = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "preference",
            scope: "global",
            text: "Prefer concise MCP updates.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };
        parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "blocker",
            scope: "project",
            project_id: "other",
            tags: ["mcp"],
            text: "Other MCP project is blocked by stale credentials.",
            state: "canonical",
            priority: "high",
            source: { client: "mcp-test" }
          }
        }));
        const globalRefresh = parseTextContent(await client.callTool({
          name: "refresh",
          arguments: {
            cursor: "2000-01-01T00:00:00.000Z",
            current_task: "fix mcp stale credentials"
          }
        })) as { should_interrupt: boolean; changes: Array<{ record_id: string; summary: string; importance: string }> };

        expect(globalRefresh.should_interrupt).toBe(false);
        expect(globalRefresh.changes).toContainEqual(expect.objectContaining({
          record_id: globalPreference.record.id,
          summary: "Prefer concise MCP updates.",
          importance: "notice"
        }));
        expect(JSON.stringify(globalRefresh)).not.toContain("Other MCP project is blocked");

        const oldResult = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Old MCP decision.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        parseTextContent(await client.callTool({
          name: "link",
          arguments: {
            record_id: writeResult.record.id,
            linked_record_id: oldResult.record.id,
            link_type: "supersedes",
            source: { client: "mcp-test" }
          }
        }));
        parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: oldResult.record.id,
            reason: "Superseded through MCP",
            source: { client: "mcp-test" }
          }
        }));

        const archivedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [oldResult.record.id],
            states: ["archived"],
            project_id: "moryn"
          }
        })) as { results: Array<{ record: { state: string } }> };
        const linkedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [writeResult.record.id],
            project_id: "moryn"
          }
        })) as { results: Array<{ record: { links?: Array<{ record_id: string; link_type: string }> } }> };

        expect(archivedRecall.results[0]?.record.state).toBe("archived");
        expect(linkedRecall.results[0]?.record.links).toEqual([
          expect.objectContaining({ record_id: oldResult.record.id, link_type: "supersedes" })
        ]);

        parseTextContent(await client.callTool({
          name: "quarantine",
          arguments: {
            record_id: writeResult.record.id,
            reason: "Manual review through MCP",
            source: { client: "mcp-test" }
          }
        }));
        const quarantinedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [writeResult.record.id],
            states: ["quarantined"],
            project_id: "moryn"
          }
        })) as { results: Array<{ record: { state: string } }> };

        expect(quarantinedRecall.results[0]?.record.state).toBe("quarantined");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("exposes rebuild and Git sync operations over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-sync-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          expect((parseTextContent(await agentA.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

          const initA = parseTextContent(await agentA.callTool({
            name: "sync_init",
            arguments: { remote }
          })) as { ok: boolean };
          const initB = parseTextContent(await agentB.callTool({
            name: "sync_init",
            arguments: { remote }
          })) as { ok: boolean };

          expect(initA.ok).toBe(true);
          expect(initB.ok).toBe(true);

          parseTextContent(await agentA.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "moryn",
              text: "MCP sync shares events.",
              state: "canonical",
              source: { client: "mcp-sync-test", device_id: "device_a" }
            }
          }));

          const push = parseTextContent(await agentA.callTool({
            name: "sync_push",
            arguments: { message: "sync from mcp agent a" }
          })) as { ok: boolean; pushed?: boolean };
          expect(push.ok).toBe(true);
          expect(push.pushed).toBe(true);

          const pull = parseTextContent(await agentB.callTool({
            name: "sync_pull",
            arguments: {}
          })) as { ok: boolean; pulled?: boolean };
          expect(pull.ok).toBe(true);
          expect(pull.pulled).toBe(true);

          const rebuild = parseTextContent(await agentB.callTool({
            name: "rebuild",
            arguments: {}
          })) as {
            ok: boolean;
            records: number;
            artifacts: {
              snapshots: { projects_by_id: Record<string, string> };
              indexes: { recall: string };
            };
            selection_sources: Record<string, string>;
          };
          expect(rebuild.ok).toBe(true);
          expect(rebuild.records).toBe(1);
          expect(rebuild.selection_sources).toEqual(REBUILD_SELECTION_SOURCES);
          expect(rebuild.artifacts.snapshots.projects_by_id.moryn).toBe("snapshots/projects/moryn.json");
          expect(rebuild.artifacts.indexes.recall).toBe("indexes/recall.json");

          const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
          expect(recallIndex.records.map((record) => record.text)).toContain("MCP sync shares events.");

          const status = parseTextContent(await agentB.callTool({
            name: "sync_status",
            arguments: {}
          })) as { configured: boolean; remote?: string };
          expect(status.configured).toBe(true);
          expect(status.remote).toBe(remote);
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("returns safe sync status recovery actions when remote sync is unavailable over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-missing-sync-remote-"));
    const store = join(root, "store");
    const missingRemote = join(root, "missing-remote.git");
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const response = await client.callTool({
          name: "sync_init",
          arguments: { remote: missingRemote }
        });

        expect("isError" in response ? response.isError : false).toBe(true);
        const result = parseTextContent(response) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("SYNC_REMOTE_UNAVAILABLE");
        expect(result.error.recommended_action).toBe("continue locally and retry sync later");
        expect(result.error.next_action).toMatchObject({
          recommended_action: "check_sync_status_before_retrying_remote_operation",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns safe sync status recovery actions for sync conflicts over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-sync-conflict-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
    try {
      await exec("git", ["init", "--bare", remote]);
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          expect((parseTextContent(await agentA.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentA.callTool({ name: "sync_init", arguments: { remote } })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "sync_init", arguments: { remote } })) as { ok: boolean }).ok).toBe(true);

          await mkdir(join(storeA, "events", "shared-device", "2026-05"), { recursive: true });
          await mkdir(join(storeB, "events", "shared-device", "2026-05"), { recursive: true });
          await writeFile(join(storeA, conflictFile), "{\"from\":\"a\"}\n", "utf8");
          await writeFile(join(storeB, conflictFile), "{\"from\":\"b\"}\n", "utf8");
          await exec("git", ["add", conflictFile], { cwd: storeA });
          await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: storeA });
          await exec("git", ["push", "-u", "origin", "main"], { cwd: storeA });
          await exec("git", ["add", conflictFile], { cwd: storeB });
          await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: storeB });

          const response = await agentB.callTool({ name: "sync_pull", arguments: {} });
          expect("isError" in response ? response.isError : false).toBe(true);
          const result = parseTextContent(response) as {
            ok: boolean;
            error: {
              code: string;
              recommended_action: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                required_fields: string[];
                safe_to_run: boolean;
              };
            };
          };
          expect(result.ok).toBe(false);
          expect(result.error.code).toBe("SYNC_CONFLICT");
          expect(result.error.recommended_action).toBe("inspect Git sync state before retrying");
          expect(result.error.next_action).toMatchObject({
            recommended_action: "inspect_sync_conflict_before_retrying",
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            required_fields: [],
            safe_to_run: true
          });

          const status = parseTextContent(await agentB.callTool({
            name: "sync_status",
            arguments: {}
          })) as {
            sync_state?: string;
            conflict?: {
              operation?: string;
              files?: string[];
              files_by_path?: Record<string, {
                path: string;
                status: string;
                safe_to_auto_resolve: boolean;
                recommended_action: string;
              }>;
              safe_to_auto_resolve?: boolean;
              safe_to_retry_sync?: boolean;
              recommended_action?: string;
            };
          };
          expect(status.sync_state).toBe("conflict");
          expect(status.conflict).toEqual({
            operation: "rebase",
            files: [conflictFile],
            files_by_path: {
              [conflictFile]: {
                path: conflictFile,
                status: "unmerged",
                safe_to_auto_resolve: false,
                recommended_action: "resolve Git conflicts before retrying sync"
              }
            },
            safe_to_auto_resolve: false,
            safe_to_retry_sync: false,
            recommended_action: "resolve Git conflicts before retrying sync"
          });
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("exposes low-friction agent lifecycle over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-lifecycle-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, {
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: ["release"]
      });
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          expect((parseTextContent(await agentA.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentA.callTool({ name: "sync_init", arguments: { remote } })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "sync_init", arguments: { remote } })) as { ok: boolean }).ok).toBe(true);

          const finish = parseTextContent(await agentA.callTool({
            name: "agent_finish",
            arguments: {
              project_path: project,
              summary: "MCP Codex left a lifecycle handoff.",
              agent: { client: "codex", session_id: "codex-mcp", device_id: "device_a" }
            }
          })) as {
            record: { content: { text: string } };
            sync: { push?: { pushed?: boolean } };
            next: {
              workflow: {
                start: string;
                continue_from: string[];
                phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
              };
              actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
              actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
              selection_sources: Record<string, string>;
            };
          };
          expect(finish.record.content.text).toBe("MCP Codex left a lifecycle handoff.");
          expect(finish.sync.push?.pushed).toBe(true);
          expect(finish.next.recommended_start_action_id).toBe("start_next_session");
          expect(finish.next.recommended_start_action_source).toBe("next.actions_by_id.start_next_session");
          expect(finish.next.selection_sources).toEqual({
            action: "next.actions_by_id.<action>",
            action_id: "next.actions_by_id.<action>.action"
          });
          expect(finish.next.actions).toContainEqual(expect.objectContaining({
            action: "start_next_session",
            tool: "agent_start",
            command: expect.stringContaining("moryn agent start"),
            required_when: "When another agent or device should start the next session from this handoff.",
            required_fields: ["current_task"],
            argument_sources: {
              current_task: "user_input.current_task"
            },
            arguments: expect.objectContaining({
              project_path: project,
              current_task: "<current_task>",
              agent: { client: "codex", session_id: "codex-mcp", device_id: "device_a" }
            })
          }));
          for (const action of finish.next.actions) {
            expectLifecycleActionSelectionSources(action);
          }
          expect(finish.next.actions_by_id.start_next_session).toEqual(finish.next.actions.find((action) => action.action === "start_next_session"));
          expectLifecycleActionSelectionSources(finish.next.actions_by_id.start_next_session);
          expect(finish.next.actions_by_id[finish.next.recommended_start_action_id]).toEqual(finish.next.actions_by_id.start_next_session);
          expect(finish.next.workflow).toEqual(withPhasesByName({
            version: 1,
            start: "next.actions_by_id",
            continue_from: ["next.actions_by_id", "next.actions"],
            phases: [
              {
                phase: "start_next_session",
                order: 1,
                action_source: "next.actions_by_id.start_next_session",
                tool: "agent_start",
                required_when: "When another agent or device should start the next session from this handoff.",
                required_fields: ["current_task"]
              }
            ]
          }));

          const start = parseTextContent(await agentB.callTool({
            name: "agent_start",
            arguments: {
              project_path: project,
              current_task: "continue lifecycle handoff",
              refresh_since: "2000-01-01T00:00:00.000Z",
              agent: { client: "gemini", session_id: "gemini-mcp", device_id: "device_b" }
            }
          })) as {
            project: { project_id: string };
            sync: { pull?: { pulled?: boolean } };
            refresh: { cursor: string; changes: Array<{ summary: string; importance: string }> };
            handoff: {
              next_action: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
                required_when: string;
                required_fields: string[];
              };
              inbox: Array<{
                record_id: string;
                text: string;
                agent: { client?: string; session_id?: string; device_id?: string };
                recommended_action: string;
                next_action: {
                  recommended_action: string;
                  tool: string;
                  command: string;
                  arguments: Record<string, unknown>;
                  safe_to_run: boolean;
                  required_when: string;
                  required_fields: string[];
                  workflow?: Record<string, unknown>;
                };
              }>;
              inbox_by_record_id: Record<string, {
                record_id: string;
                next_action: {
                  workflow?: Record<string, unknown>;
                };
              }>;
              active_sessions: Array<{ text: string }>;
              active_sessions_by_record_id: Record<string, { record_id: string }>;
              selection_sources: Record<string, string>;
            };
            next: {
              workflow: {
                start: string;
                phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
              };
              actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
              actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
              selection_sources: Record<string, string>;
            };
          };
          expect(start.project.project_id).toBe("moryn");
          expect(start.sync.pull?.pulled).toBe(true);
          expect(start.refresh.changes).toContainEqual(expect.objectContaining({
            summary: "MCP Codex left a lifecycle handoff.",
            importance: "notice"
          }));
          expect(start.handoff.inbox).toEqual([
            expect.objectContaining({
              text: "MCP Codex left a lifecycle handoff.",
              agent: { client: "codex", session_id: "codex-mcp", device_id: "device_a" },
              recommended_action: "review_handoff_summary",
              next_action: expect.any(Object)
            })
          ]);
          expect(start.handoff.inbox_by_record_id[start.handoff.inbox[0]!.record_id]).toEqual(start.handoff.inbox[0]);
          expect(start.handoff.selection_sources).toEqual({
            inbox_entry: "handoff.inbox_by_record_id.<record_id>",
            inbox_record_id: "handoff.inbox_by_record_id.<record_id>.record_id",
            inbox_next_action: "handoff.inbox_by_record_id.<record_id>.next_action",
            active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
            active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
            active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action"
          });
          expectHandoffEntryNextAction(start.handoff.inbox[0]!.next_action, start.handoff.inbox[0]!.record_id, "moryn");
          expect(start.handoff.inbox_by_record_id[start.handoff.inbox[0]!.record_id]!.next_action.workflow).toEqual(start.handoff.inbox[0]!.next_action.workflow);
          expect(start.handoff.next_action).toEqual(start.handoff.inbox[0]!.next_action);
          expectHandoffEntryNextAction(start.handoff.next_action, start.handoff.inbox[0]!.record_id, "moryn");
          expect(start.handoff.active_sessions).toEqual([]);
          expect(start.handoff.active_sessions_by_record_id).toEqual({});
          expect(start.next.actions_by_id.publish_status).toEqual(start.next.actions.find((action) => action.action === "publish_status"));
          expect(start.next.actions_by_id.finish_session).toEqual(start.next.actions.find((action) => action.action === "finish_session"));
          expect(start.next.actions_by_id.refresh_context).toEqual(start.next.actions.find((action) => action.action === "refresh_context"));
          expectLifecycleActionSelectionSources(start.next.actions_by_id.publish_status);
          expectLifecycleActionSelectionSources(start.next.actions_by_id.finish_session);
          expectLifecycleActionSelectionSources(start.next.actions_by_id.refresh_context);
          expect(start.next.required_end_action_id).toBe("finish_session");
          expect(start.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
          expect(start.next.recommended_refresh_action_id).toBe("refresh_context");
          expect(start.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
          expect(start.next.selection_sources).toEqual({
            action: "next.actions_by_id.<action>",
            action_id: "next.actions_by_id.<action>.action"
          });
          expect(start.next.actions_by_id[start.next.required_end_action_id]).toEqual(start.next.actions_by_id.finish_session);
          expect(start.next.actions_by_id[start.next.recommended_refresh_action_id]).toEqual(start.next.actions_by_id.refresh_context);
          expect(start.next.actions).toContainEqual(expect.objectContaining({
            action: "publish_status",
            tool: "agent_status",
            safe_to_run: false,
            command: expect.stringContaining("moryn agent status"),
            required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
            required_fields: ["status"],
            argument_sources: {
              status: "user_input.status"
            },
            arguments: expect.objectContaining({
              project_path: project,
              status: "<status>",
              current_task: "continue lifecycle handoff"
            })
          }));
          expect(start.next.actions).toContainEqual(expect.objectContaining({
            action: "refresh_context",
            tool: "agent_start",
            safe_to_run: true,
            command: expect.stringContaining("--refresh-since"),
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: [],
            argument_sources: {
              refresh_since: "refresh.cursor"
            },
            arguments: expect.objectContaining({
              project_path: project,
              refresh_since: start.refresh.cursor,
              current_task: "continue lifecycle handoff"
            })
          }));
          for (const action of start.next.actions) {
            expectLifecycleActionSelectionSources(action);
          }
          expect(start.next.workflow).toEqual(withPhasesByName({
            version: 1,
            start: "context",
            continue_from: ["boot", "refresh", "handoff", "next.actions_by_id", "next.actions"],
            phases: [
              {
                phase: "review_context",
                order: 1,
                action_source: "boot+refresh+handoff",
                required_when: "Immediately after agent_start returns, review boot, refresh, and handoff context before taking user-task actions.",
                required_fields: []
              },
              {
                phase: "publish_status",
                order: 2,
                action_source: "next.actions_by_id.publish_status",
                tool: "agent_status",
                required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
                required_fields: ["status"]
              },
              {
                phase: "finish_session",
                order: 3,
                action_source: "next.actions_by_id.finish_session",
                tool: "agent_finish",
                required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
                required_fields: ["summary"]
              },
              {
                phase: "refresh_context",
                order: 4,
                action_source: "next.actions_by_id.refresh_context",
                tool: "agent_start",
                required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
                required_fields: []
              }
            ]
          }));
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("returns portable lifecycle action arguments over MCP when project config resolves from cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-portable-actions-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(store, async (client) => {
        const start = parseTextContent(await client.callTool({
          name: "agent_start",
          arguments: {
            current_task: "continue from portable actions",
            agent: { client: "codex", session_id: "codex-mcp-portable" }
          }
        })) as {
          next: { actions: Array<{ action: string; command: string; arguments: Record<string, unknown> }> };
        };

        expect(start.next.actions).toContainEqual(expect.objectContaining({
          action: "publish_status",
          safe_to_run: false,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn", status: "<status>" })
        }));
        expect(start.next.actions).toContainEqual(expect.objectContaining({
          action: "finish_session",
          safe_to_run: false,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn", summary: "<summary>" })
        }));
        expect(start.next.actions).toContainEqual(expect.objectContaining({
          action: "refresh_context",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        }));
      }, project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps store and sync from agent lifecycle MCP tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-bootstrap-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "fresh-store-a");
    const storeB = join(root, "fresh-store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          const finish = parseTextContent(await agentA.callTool({
            name: "agent_finish",
            arguments: {
              project_path: project,
              sync_remote: remote,
              summary: "MCP fresh store wrote the first handoff.",
              agent: { client: "codex", session_id: "codex-bootstrap" }
            }
          })) as { bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } }; sync: { push?: { pushed?: boolean } } };
          expect(finish.bootstrap.initialized_store).toBe(true);
          expect(finish.bootstrap.sync_init?.ok).toBe(true);
          expect(finish.sync.push?.pushed).toBe(true);

          const start = parseTextContent(await agentB.callTool({
            name: "agent_start",
            arguments: {
              project_path: project,
              sync_remote: remote,
              current_task: "read fresh handoff",
              refresh_since: "2000-01-01T00:00:00.000Z",
              agent: { client: "gemini", session_id: "gemini-bootstrap" }
            }
          })) as {
            bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } };
            sync: { pull?: { pulled?: boolean } };
            refresh: { changes: Array<{ summary: string }> };
          };
          expect(start.bootstrap.initialized_store).toBe(true);
          expect(start.bootstrap.sync_init?.ok).toBe(true);
          expect(start.sync.pull?.pulled).toBe(true);
          expect(start.refresh.changes).toContainEqual(expect.objectContaining({
            summary: "MCP fresh store wrote the first handoff."
          }));
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("shares in-progress agent status through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-status-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "fresh-store-a");
    const storeB = join(root, "fresh-store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          const status = parseTextContent(await agentA.callTool({
            name: "agent_status",
            arguments: {
              project_path: project,
              sync_remote: remote,
              current_task: "coordinate MCP status",
              status: "MCP Codex is currently wiring status propagation.",
              agent: { client: "codex", session_id: "codex-mcp-status" }
            }
          })) as {
            record: { kind: string; type: string; updated_at: string; content: { text: string; current_task?: string } };
            sync: { push?: { pushed?: boolean } };
            next: {
              workflow: {
                start: string;
                phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
              };
              actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
            };
          };
          expect(status.record).toMatchObject({
            kind: "session_summary",
            type: "status",
            content: {
              text: "MCP Codex is currently wiring status propagation.",
              current_task: "coordinate MCP status"
            }
          });
          expect(status.sync.push?.pushed).toBe(true);
          expect(status.next.actions).toContainEqual(expect.objectContaining({
            action: "finish_session",
            tool: "agent_finish",
            command: expect.stringContaining("moryn agent finish"),
            required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
            required_fields: ["summary"],
            argument_sources: {
              summary: "user_input.summary"
            },
            arguments: expect.objectContaining({
              project_path: project,
              sync_remote: remote,
              current_task: "coordinate MCP status"
            })
          }));
          expect(status.next.actions).toContainEqual(expect.objectContaining({
            action: "refresh_context",
            tool: "agent_start",
            command: expect.stringContaining("--refresh-since"),
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: [],
            argument_sources: {
              refresh_since: "record.updated_at"
            },
            arguments: expect.objectContaining({
              project_path: project,
              sync_remote: remote,
              refresh_since: status.record.updated_at,
              current_task: "coordinate MCP status"
            })
          }));
          expect(status.next.actions_by_id.finish_session).toEqual(status.next.actions.find((action) => action.action === "finish_session"));
          expect(status.next.actions_by_id.refresh_context).toEqual(status.next.actions.find((action) => action.action === "refresh_context"));
          expect(status.next.recommended_finish_action_id).toBe("finish_session");
          expect(status.next.recommended_finish_action_source).toBe("next.actions_by_id.finish_session");
          expect(status.next.recommended_refresh_action_id).toBe("refresh_context");
          expect(status.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
          expect(status.next.actions_by_id[status.next.recommended_finish_action_id]).toEqual(status.next.actions_by_id.finish_session);
          expect(status.next.actions_by_id[status.next.recommended_refresh_action_id]).toEqual(status.next.actions_by_id.refresh_context);
          expect(status.next.workflow).toEqual(withPhasesByName({
            version: 1,
            start: "next.actions_by_id",
            continue_from: ["record", "next.actions_by_id", "next.actions"],
            phases: [
              {
                phase: "finish_session",
                order: 1,
                action_source: "next.actions_by_id.finish_session",
                tool: "agent_finish",
                required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
                required_fields: ["summary"]
              },
              {
                phase: "refresh_context",
                order: 2,
                action_source: "next.actions_by_id.refresh_context",
                tool: "agent_start",
                required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
                required_fields: []
              }
            ]
          }));

          const start = parseTextContent(await agentB.callTool({
            name: "agent_start",
            arguments: {
              project_path: project,
              sync_remote: remote,
              current_task: "coordinate MCP status",
              refresh_since: "2000-01-01T00:00:00.000Z",
              agent: { client: "gemini", session_id: "gemini-mcp-status" }
            }
          })) as { refresh: { changes: Array<{ summary: string; importance: string }> } };
          expect(start.refresh.changes).toContainEqual(expect.objectContaining({
            summary: "MCP Codex is currently wiring status propagation.",
            importance: "notice"
          }));
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("returns read-only agent doctor guidance through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-doctor-"));
    const remote = join(root, "remote.git");
    const store = join(root, "fresh-store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(store, async (client) => {
        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            project_path: project,
            sync_remote: remote,
            current_task: "start safely from MCP",
            agent: { client: "gemini", session_id: "gemini-doctor" }
          }
        })) as {
          store: { initialized: boolean };
          project: { ok: boolean; project_id?: string };
          sync: { configured: boolean; expected_remote?: string };
          checks: Array<{ name: string; ok: boolean; severity: string; message: string }>;
          checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
          selection_sources: Record<string, string>;
          readiness?: {
            safe_to_start: boolean;
            blocking_checks: string[];
            blocking_checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
            recommended_action: string;
            next_tool: string;
            next_command: string;
            next_safe_to_run: boolean;
            next_required_when: string;
            next_required_fields: string[];
            next_required_fields_by_name: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            next_argument_sources: Record<string, string>;
            next_selection_sources: Record<string, string>;
            next_safety: {
              safe_to_auto_run: boolean;
              requires_user_confirmation: boolean;
              requires_authored_input: boolean;
              writes_local_config: boolean;
              reasons: string[];
            };
            next_interfaces: {
              cli: { command: string };
              mcp: { tool: string; arguments: Record<string, unknown> };
            };
            next_workflow: Record<string, unknown>;
            next_arguments: Record<string, unknown>;
          };
          next: {
            tool: string;
            command: string;
            interfaces: {
              cli: { command: string };
              mcp: { tool: string; arguments: Record<string, unknown> };
            };
            workflow: Record<string, unknown>;
            required_fields_by_name: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            actions: Array<{ action: string; tool: string; command: string; required_fields: string[]; arguments: Record<string, unknown> }>;
            actions_by_id: Record<string, { action: string; tool: string; command: string; required_fields: string[]; arguments: Record<string, unknown> }>;
            selection_sources: Record<string, string>;
            arguments: {
              project_path?: string;
              sync_remote?: string;
              current_task?: string;
              agent?: { client?: string; session_id?: string };
            };
          };
        };

        expect(doctor.store.initialized).toBe(false);
        expect(doctor.project).toMatchObject({ ok: true, project_id: "moryn" });
        expect(doctor.sync).toMatchObject({ configured: false, expected_remote: remote });
        expect(doctor.next.tool).toBe("agent_start");
        expect(doctor.readiness).toEqual({
          safe_to_start: true,
          blocking_checks: [],
          blocking_checks_by_name: {},
          recommended_action: "call_agent_start",
          next_tool: "agent_start",
          next_command: doctor.next.command,
          next_safe_to_run: true,
          next_required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
          next_required_fields: [],
          next_required_fields_by_name: {},
          next_argument_sources: {},
          next_selection_sources: doctor.next.selection_sources,
          next_safety: {
            safe_to_auto_run: true,
            requires_user_confirmation: false,
            requires_authored_input: false,
            writes_local_config: false,
            reasons: ["safe_read_or_status_check"]
          },
          next_interfaces: doctor.next.interfaces,
          next_workflow: doctor.next.workflow,
          next_arguments: {
            project_path: project,
            sync_remote: remote,
            current_task: "start safely from MCP",
            agent: { client: "gemini", session_id: "gemini-doctor" }
          }
        });
        expect(doctor.readiness?.next_required_when).toEqual(doctor.next.required_when);
        expect(doctor.readiness?.next_required_fields_by_name).toEqual(doctor.next.required_fields_by_name);
        expect(doctor.readiness?.next_selection_sources).toEqual(doctor.next.selection_sources);
        expect(doctor.selection_sources).toEqual({
          check: "checks_by_name.<check_name>",
          blocking_check: "readiness.blocking_checks_by_name.<check_name>",
          next_action: "next"
        });
        expect(doctor.checks_by_name.store).toEqual(doctor.checks.find((check) => check.name === "store"));
        expect(doctor.checks_by_name.project).toEqual(doctor.checks.find((check) => check.name === "project"));
        expect(doctor.checks_by_name.sync).toEqual(doctor.checks.find((check) => check.name === "sync"));
        expect(doctor.next.command).toContain("moryn agent start");
        expect(doctor.next.actions).toContainEqual(expect.objectContaining({
          action: "run_lifecycle_smoke",
          tool: "moryn-agent-smoke",
          command: expect.stringContaining("moryn-agent-smoke"),
          required_fields: [],
          arguments: expect.objectContaining({ remote })
        }));
        expect(doctor.next.actions_by_id.start_session).toEqual(doctor.next.actions.find((action) => action.action === "start_session"));
        expect(doctor.next.actions_by_id.run_lifecycle_smoke).toEqual(doctor.next.actions.find((action) => action.action === "run_lifecycle_smoke"));
        expectLifecycleActionSelectionSources(doctor.next.actions_by_id.start_session);
        expectLifecycleActionSelectionSources(doctor.next.actions_by_id.run_lifecycle_smoke);
        expect(doctor.next.selection_sources).toEqual({
          action: "next.actions_by_id.<action>",
          action_id: "next.actions_by_id.<action>.action"
        });
        expect(doctor.next.arguments).toMatchObject({
          project_path: project,
          sync_remote: remote,
          current_task: "start safely from MCP",
          agent: { client: "gemini", session_id: "gemini-doctor" }
        });
        await expect(readFile(join(store, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns sync conflict guidance from MCP doctor and enter before lifecycle writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-sync-conflict-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await createMcpSyncConflict({ remote, storeA, storeB, conflictFile });

      await withMcpClient(storeB, async (client) => {
        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            project_path: project,
            sync_remote: remote,
            current_task: "avoid sync conflict hallucination",
            agent: { client: "gemini", session_id: "gemini-conflict" }
          }
        })) as {
          sync: {
            sync_state?: string;
            conflict?: {
              files?: string[];
              files_by_path?: Record<string, {
                path: string;
                status: string;
                safe_to_auto_resolve: boolean;
                recommended_action: string;
              }>;
              safe_to_retry_sync?: boolean;
            };
          };
          checks: Array<{ name: string; ok: boolean; severity: string; message: string }>;
          checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
          readiness?: {
            safe_to_start: boolean;
            blocking_checks: string[];
            blocking_checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
            recommended_action: string;
            next_tool: string;
            next_command: string;
            next_required_when: string;
            next_safety: Record<string, unknown>;
            next_interfaces: Record<string, unknown>;
            next_workflow: Record<string, unknown>;
            next_argument_sources: Record<string, string>;
            next_selection_sources: Record<string, string>;
          };
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
            arguments: Record<string, unknown>;
            interfaces: Record<string, unknown>;
            safety?: {
              safe_to_auto_run?: boolean;
              requires_user_confirmation?: boolean;
              requires_authored_input?: boolean;
              writes_local_config?: boolean;
              reasons?: string[];
            };
          };
        };
        expect(doctor.sync).toMatchObject({
          sync_state: "conflict",
          conflict: {
            files: [conflictFile],
            files_by_path: {
              [conflictFile]: {
                path: conflictFile,
                status: "unmerged",
                safe_to_auto_resolve: false,
                recommended_action: "resolve Git conflicts before retrying sync"
              }
            },
            safe_to_retry_sync: false
          }
        });
        expect(doctor.next).toMatchObject({
          recommended_action: "resolve_sync_conflict_before_lifecycle",
          tool: "sync_status",
          safe_to_run: true,
          command: "moryn sync --status",
          required_when: INSPECT_SYNC_CONFLICT_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "resolve_sync_conflict_before_lifecycle",
            tool: "sync_status",
            requiredWhen: INSPECT_SYNC_CONFLICT_WHEN
          }),
          interfaces: {
            cli: {
              command: "moryn sync --status"
            },
            mcp: {
              tool: "sync_status",
              arguments: {}
            }
          },
          arguments: {}
        });
        expectActionSafety(doctor.next);
        expect(doctor.next.safety).toMatchObject({
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: false,
          writes_local_config: false,
          reasons: ["safe_read_or_status_check"]
        });
        expect(doctor.readiness).toEqual({
          safe_to_start: false,
          blocking_checks: ["sync"],
          blocking_checks_by_name: {
            sync: doctor.checks_by_name.sync
          },
          recommended_action: "resolve_sync_conflict_before_lifecycle",
          next_tool: "sync_status",
          next_command: "moryn sync --status",
          next_safe_to_run: true,
          next_required_when: INSPECT_SYNC_CONFLICT_WHEN,
          next_required_fields: [],
          next_required_fields_by_name: {},
          next_argument_sources: {},
          next_selection_sources: {},
          next_safety: doctor.next.safety,
          next_interfaces: doctor.next.interfaces,
          next_workflow: doctor.next.workflow,
          next_arguments: {}
        });
        expect(doctor.checks_by_name.sync).toEqual(expect.objectContaining({
          name: "sync",
          ok: false,
          severity: "warning",
          message: "Sync has unresolved Git conflicts; inspect sync_status and resolve conflicts before lifecycle writes."
        }));

        const entered = parseTextContent(await client.callTool({
          name: "agent_enter",
          arguments: {
            project_path: project,
            sync_remote: remote,
            current_task: "avoid sync conflict hallucination",
            agent: { client: "gemini", session_id: "gemini-conflict" }
          }
        })) as {
          mode: string;
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
          };
        };
        expect(entered).toMatchObject({
          mode: "needs_setup",
          next: {
            recommended_action: "resolve_sync_conflict_before_lifecycle",
            tool: "sync_status",
            safe_to_run: true,
            required_when: INSPECT_SYNC_CONFLICT_WHEN,
            required_fields: [],
            workflow: singleNextWorkflow({
              recommendedAction: "resolve_sync_conflict_before_lifecycle",
              tool: "sync_status",
              requiredWhen: INSPECT_SYNC_CONFLICT_WHEN
            })
          }
        });

        const startResponse = await client.callTool({
          name: "agent_start",
          arguments: {
            project_path: project,
            sync_remote: remote,
            current_task: "avoid sync conflict hallucination",
            agent: { client: "gemini", session_id: "gemini-conflict" }
          }
        });
        expect("isError" in startResponse ? startResponse.isError : false).toBe(true);
        const parsedStart = parseTextContent(startResponse) as {
          error: {
            code: string;
            message: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsedStart.error.code).toBe("SYNC_CONFLICT");
        expect(parsedStart.error.message).toBe("Sync conflict: resolve Git conflicts before lifecycle writes");
        expect(parsedStart.error.next_action).toMatchObject({
          recommended_action: "inspect_sync_conflict_before_retrying",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        });

        for (const call of [
          {
            name: "agent_status",
            arguments: {
              project_path: project,
              sync_remote: remote,
              current_task: "avoid sync conflict hallucination",
              status: "Do not write status while sync is conflicted.",
              agent: { client: "gemini", session_id: "gemini-conflict" }
            }
          },
          {
            name: "agent_finish",
            arguments: {
              project_path: project,
              sync_remote: remote,
              summary: "Do not write finish handoff while sync is conflicted.",
              agent: { client: "gemini", session_id: "gemini-conflict" }
            }
          }
        ]) {
          const response = await client.callTool(call);
          expect("isError" in response ? response.isError : false).toBe(true);
          const parsed = parseTextContent(response) as {
            error: {
              code: string;
              message: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
              };
            };
          };
          expect(parsed.error.code).toBe("SYNC_CONFLICT");
          expect(parsed.error.message).toBe("Sync conflict: resolve Git conflicts before lifecycle writes");
          expect(parsed.error.next_action).toMatchObject({
            recommended_action: "inspect_sync_conflict_before_retrying",
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            required_fields: [],
            safe_to_run: true
          });
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("recommends project discovery through MCP doctor when project input is missing", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-doctor-project-list-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Moryn MCP project handoff is available.",
            source: { client: "codex", session_id: "codex-mcp-project-list" }
          }
        });

        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            current_task: "find project from MCP",
            agent: { client: "gemini", session_id: "gemini-mcp-project-list" }
          }
        })) as {
          project: { ok: boolean };
          next: {
            recommended_action: string;
            tool: string;
            command: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
            actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[] }>;
            actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[] }>;
            selection_sources: Record<string, string>;
          };
        };

        expect(doctor.next).toMatchObject({
          recommended_action: "list_projects",
          tool: "project_list",
          safe_to_run: true,
          command: "moryn project list",
          required_when: LIST_PROJECTS_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "list_projects",
            tool: "project_list",
            requiredWhen: LIST_PROJECTS_WHEN
          })
        });
        expect(doctor.next.actions).toContainEqual(expect.objectContaining({
          action: "list_projects",
          tool: "project_list",
          command: "moryn project list",
          required_when: LIST_PROJECTS_WHEN,
          required_fields: []
        }));
        expect(doctor.next.actions_by_id.list_projects).toEqual(doctor.next.actions[0]);
        expectLifecycleActionSelectionSources(doctor.next.actions_by_id.list_projects);
        expect(doctor.next.selection_sources).toEqual({
          action: "next.actions_by_id.<action>",
          action_id: "next.actions_by_id.<action>.action"
        });
      }, store);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("prefills project list startup commands through MCP arguments", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-project-list-next-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Moryn MCP project handoff is available.",
            source: { client: "codex", session_id: "codex-mcp-list-next" }
          }
        });

        const listed = parseTextContent(await client.callTool({
          name: "project_list",
          arguments: {
            current_task: "continue MCP handoff",
            sync_remote: "git@github.com:user/moryn-store.git",
            agent: { client: "gemini", session_id: "gemini-mcp-list-next" }
          }
        })) as {
          projects: Array<{
            next: {
              command: string;
              arguments: {
                project_id: string;
                sync_remote?: string;
                current_task?: string;
                agent?: { client: string; session_id?: string };
              };
            };
          }>;
        };

        expect(listed.projects[0]?.next.command).toBe("moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue MCP handoff' --agent gemini --session-id gemini-mcp-list-next");
        expect(listed.projects[0]?.next.arguments).toMatchObject({
          project_id: "moryn",
          sync_remote: "git@github.com:user/moryn-store.git",
          current_task: "continue MCP handoff",
          agent: { client: "gemini", session_id: "gemini-mcp-list-next" }
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("enters project discovery through MCP when project input is missing", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-enter-project-list-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Moryn MCP enter handoff is available.",
            source: { client: "codex", session_id: "codex-mcp-enter" }
          }
        });

        const entered = parseTextContent(await client.callTool({
          name: "agent_enter",
          arguments: {
            current_task: "find MCP project",
            sync_remote: "git@github.com:user/moryn-store.git",
            agent: { client: "gemini", session_id: "gemini-mcp-enter" }
          }
        })) as {
          mode: string;
          projects: { projects: Array<{ project_id: string; next: { command: string } }> };
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            required_fields_by_name: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            arguments: Record<string, unknown>;
            safety: {
              safe_to_auto_run: boolean;
              requires_user_confirmation: boolean;
              requires_authored_input: boolean;
              writes_local_config: boolean;
              reasons: string[];
            };
            workflow: {
              version: number;
              start: string;
              continue_from: string[];
              phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
            };
            actions: Array<{
              project_id: string;
              required_when?: string;
              command?: string;
              arguments?: Record<string, unknown>;
              lifecycle?: Array<{
                step: string;
                tool: string;
                command: string;
                required_when: string;
                required_fields: string[];
                workflow?: Record<string, unknown>;
              }>;
              lifecycle_by_step?: Record<string, {
                step: string;
                tool: string;
                command: string;
                required_when: string;
                required_fields: string[];
                workflow?: Record<string, unknown>;
              }>;
            }>;
            actions_by_project_id: Record<string, {
              project_id: string;
              command: string;
              arguments: Record<string, unknown>;
              lifecycle?: Array<{ step: string; tool: string; command: string; required_when: string; required_fields: string[]; workflow?: Record<string, unknown> }>;
              lifecycle_by_step?: Record<string, { step: string; tool: string; command: string; required_when: string; required_fields: string[]; workflow?: Record<string, unknown> }>;
            }>;
          };
        };

        expect(entered.mode).toBe("discover_projects");
        expect(entered.next).toMatchObject({
          recommended_action: "choose_project_and_call_agent_start",
          tool: "agent_start",
          safe_to_run: true,
          required_when: "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
          required_fields: ["project_id"],
          required_fields_by_name: {
            project_id: {
              name: "project_id",
              argument_path: "project_id",
              value: "<project_id>",
              placeholder: "<project_id>"
            }
          },
          argument_sources: {
            project_id: "next.actions_by_project_id.<project_id>.project_id"
          },
          selection_sources: {
            project: "projects.projects_by_id.<project_id>",
            project_id: "projects.projects_by_id.<project_id>.project_id",
            start_action: "next.actions_by_project_id.<project_id>",
            lifecycle_actions: "next.actions_by_project_id.<project_id>.lifecycle_by_step"
          },
          arguments: { project_id: "<project_id>" },
          safety: {
            safe_to_auto_run: true,
            requires_user_confirmation: false,
            requires_authored_input: true,
            writes_local_config: false,
            reasons: ["required_fields"]
          }
        });
        expect(entered.next.command).toBe("moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-enter");
        expectActionInterfaces(entered.next);
        expect(entered.next.workflow).toEqual(withPhasesByName({
          version: 1,
          start: "projects",
          continue_from: [
            "next.actions_by_project_id",
            "next.actions",
            "next.actions_by_project_id.<project_id>.lifecycle_by_step",
            "next.actions_by_project_id.<project_id>.lifecycle",
            "agent_start.next.actions_by_id",
            "agent_start.next.actions"
          ],
          phases: [
            {
              phase: "choose_project",
              order: 1,
              action_source: "projects.projects",
              required_when: "When agent_enter returns discover_projects mode, choose one returned project instead of guessing a project id.",
              required_fields: []
            },
            {
              phase: "start_session",
              order: 2,
              action_source: "next.actions_by_project_id.<project_id>",
              tool: "agent_start",
              required_when: "After choosing this project from discovery results.",
              required_fields: []
            },
            {
              phase: "continue_selected_project_lifecycle",
              order: 3,
              action_source: "next.actions_by_project_id.<project_id>.lifecycle_by_step",
              required_when: "After the selected project starts, use that action's lifecycle templates for status, finish, and refresh.",
              required_fields: []
            }
          ]
        }));
        expect(entered.next.actions_by_project_id.moryn).toEqual(entered.next.actions[0]);
        expect(entered.projects.projects[0]?.project_id).toBe("moryn");
        expect(entered.projects.projects[0]?.next.command).toBe("moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-enter");
        expect(entered.next.actions[0]?.required_when).toBe("After choosing this project from discovery results.");
        const discoveredStatus = entered.next.actions[0]?.lifecycle?.find((action) => action.step === "publish_status");
        expect(entered.next.actions[0]?.lifecycle_by_step?.publish_status).toEqual(discoveredStatus);
        expect(entered.next.actions_by_project_id.moryn.lifecycle_by_step?.publish_status).toEqual(discoveredStatus);
        expect(discoveredStatus).toMatchObject({
          step: "publish_status",
          tool: "agent_status",
          safe_to_run: false,
          command: "moryn agent status --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find MCP project' --agent gemini --session-id gemini-mcp-enter --status <status>",
          required_fields: ["status"],
          argument_sources: {
            status: "user_input.status"
          }
        });
        expectLifecycleWorkflow(discoveredStatus!);
      }, store);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns runtime workflow from MCP agent_enter after starting a known project", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-agent-enter-workflow-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(store, async (client) => {
        const entered = parseTextContent(await client.callTool({
          name: "agent_enter",
          arguments: {
            project_path: project,
            current_task: "continue known MCP project",
            agent: { client: "codex", session_id: "codex-mcp-enter-known" }
          }
        })) as {
          mode: string;
          next: {
            recommended_action: string;
            actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
            actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
            workflow: {
              version: number;
              start: string;
              continue_from: string[];
              phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
            };
          };
        };

        expect(entered.mode).toBe("start_session");
        expect(entered.next.recommended_action).toBe("work_with_handoff_context");
        expect(entered.next.actions_by_id.publish_status).toEqual(entered.next.actions.find((action) => action.action === "publish_status"));
        expect(entered.next.actions_by_id.finish_session).toEqual(entered.next.actions.find((action) => action.action === "finish_session"));
        expect(entered.next.actions_by_id.refresh_context).toEqual(entered.next.actions.find((action) => action.action === "refresh_context"));
        expect(entered.next.required_end_action_id).toBe("finish_session");
        expect(entered.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
        expect(entered.next.recommended_refresh_action_id).toBe("refresh_context");
        expect(entered.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
        expect(entered.next.workflow).toEqual(withPhasesByName({
          version: 1,
          start: "start",
          continue_from: ["start.boot", "start.refresh", "start.handoff", "next.actions_by_id", "next.actions"],
          phases: [
            {
              phase: "work_with_handoff_context",
              order: 1,
              action_source: "start",
              required_when: "Immediately after agent_enter returns start_session mode, review boot, refresh, and handoff context before taking user-task actions.",
              required_fields: []
            },
            {
              phase: "publish_status",
              order: 2,
              action_source: "next.actions_by_id.publish_status",
              tool: "agent_status",
              required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
              required_fields: ["status"]
            },
            {
              phase: "finish_session",
              order: 3,
              action_source: "next.actions_by_id.finish_session",
              tool: "agent_finish",
              required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
              required_fields: ["summary"]
            },
            {
              phase: "refresh_context",
              order: 4,
              action_source: "next.actions_by_id.refresh_context",
              tool: "agent_start",
              required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
              required_fields: []
            }
          ]
        }));
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start through MCP when an explicit project path is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-missing-project-"));
    const store = join(root, "store");
    const missingProject = join(root, "missing-project");
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            project_path: missingProject,
            current_task: "avoid typo path",
            agent: { client: "codex" }
          }
        })) as {
          project: { ok: boolean; error?: string };
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
            arguments: { path?: string };
          };
        };

        expect(doctor.project.ok).toBe(false);
        expect(doctor.project.error).toContain("Project path does not exist");
        expect(doctor.next).toMatchObject({
          recommended_action: "fix_project_config",
          tool: "project_init",
          safe_to_run: false,
          command: `moryn project init --path ${missingProject}`,
          required_when: FIX_PROJECT_CONFIG_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "fix_project_config",
            tool: "project_init",
            requiredWhen: FIX_PROJECT_CONFIG_WHEN
          }),
          arguments: { path: missingProject }
        });

        const entered = parseTextContent(await client.callTool({
          name: "agent_enter",
          arguments: {
            project_path: missingProject,
            current_task: "avoid typo path",
            agent: { client: "codex" }
          }
        })) as {
          mode: string;
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
            arguments: { path?: string };
          };
        };

        expect(entered).toMatchObject({
          mode: "needs_setup",
          next: {
            recommended_action: "fix_project_config",
            tool: "project_init",
            safe_to_run: false,
            required_when: FIX_PROJECT_CONFIG_WHEN,
            required_fields: [],
            workflow: singleNextWorkflow({
              recommendedAction: "fix_project_config",
              tool: "project_init",
              requiredWhen: FIX_PROJECT_CONFIG_WHEN
            }),
            arguments: { path: missingProject }
          }
        });

        const start = await client.callTool({
          name: "agent_start",
          arguments: {
            project_path: missingProject,
            current_task: "avoid typo path",
            agent: { client: "codex" }
          }
        });
        expect("isError" in start ? start.isError : false).toBe(true);
        const parsedStart = parseTextContent(start) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              candidate_project_ids?: string[];
              safe_to_run: boolean;
            };
          };
        };
        expect(parsedStart.ok).toBe(false);
        expect(parsedStart.error.code).toBe("PROJECT_PATH_NOT_FOUND");
        expect(parsedStart.error.message).toContain("Project path does not exist");
        expect(parsedStart.error.recoverable).toBe(true);
        expect(parsedStart.error.recommended_action).toBe("run moryn project init --path <path> for a new project or retry with the correct --project/--project-id");
        expect(parsedStart.error.next_action).toMatchObject({
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: `moryn project init --path ${missingProject}`,
          arguments: { path: missingProject },
          required_fields: [],
          safe_to_run: false
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start through MCP when an explicit project id is unknown in a populated store", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-unknown-project-id-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Known MCP project handoff.",
            source: { client: "codex", session_id: "codex-known-project" }
          }
        });

        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            project_id: "morym",
            current_task: "avoid typo id",
            agent: { client: "codex" }
          }
        })) as {
          project: { ok: boolean; error?: string };
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            workflow: Record<string, unknown>;
          };
        };

        expect(doctor.project.ok).toBe(false);
        expect(doctor.project.error).toContain("Project id is not known in this store");
        expect(doctor.next).toMatchObject({
          recommended_action: "list_projects",
          tool: "project_list",
          safe_to_run: true,
          command: "moryn project list",
          required_when: LIST_PROJECTS_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "list_projects",
            tool: "project_list",
            requiredWhen: LIST_PROJECTS_WHEN
          })
        });

        const entered = parseTextContent(await client.callTool({
          name: "agent_enter",
          arguments: {
            project_id: "morym",
            current_task: "avoid typo id",
            agent: { client: "codex" }
          }
        })) as {
          mode: string;
          projects: { projects: Array<{ project_id: string }> };
          next: { recommended_action: string; tool: string };
        };

        expect(entered).toMatchObject({
          mode: "discover_projects",
          next: {
            recommended_action: "choose_project_and_call_agent_start",
            tool: "agent_start"
          }
        });
        expect(entered.projects.projects[0]?.project_id).toBe("moryn");

        const start = await client.callTool({
          name: "agent_start",
          arguments: {
            project_id: "morym",
            current_task: "avoid typo id",
            agent: { client: "codex" }
          }
        });
        expect("isError" in start ? start.isError : false).toBe(true);
        const parsedStart = parseTextContent(start) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
              workflow?: {
                phases?: Array<Record<string, unknown>>;
              };
            };
          };
        };
        expect(parsedStart.ok).toBe(false);
        expect(parsedStart.error.code).toBe("PROJECT_ID_NOT_FOUND");
        expect(parsedStart.error.message).toContain("Project id is not known in this store");
        expect(parsedStart.error.recoverable).toBe(true);
        expect(parsedStart.error.recommended_action).toBe("run moryn project list or moryn agent enter, then retry with a known --project-id");
        expect(parsedStart.error.next_action).toMatchObject({
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          argument_sources: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          rejected_arguments: { project_id: "morym" },
          candidate_project_ids: ["moryn"],
          required_fields: [],
          safe_to_run: true
        });
        expect(parsedStart.error.next_action.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_project_id",
          order: 2,
          action_source: "project_list.projects_by_id.<project_id>.project_id",
          tool: "agent_start",
          command: "moryn agent start --project-id <project_id_from_project_list> --current-task 'avoid typo id' --agent codex",
          arguments: { project_id: "<project_id_from_project_list>", current_task: "avoid typo id", agent: { client: "codex" } },
          replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
          required_fields: ["project_id"]
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start through MCP when project path config conflicts with explicit project id", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-conflicting-project-id-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(store, async (client) => {
        const doctor = parseTextContent(await client.callTool({
          name: "agent_doctor",
          arguments: {
            project_path: project,
            project_id: "other",
            current_task: "avoid conflicting project id",
            agent: { client: "codex" }
          }
        })) as {
          project: { ok: boolean; error?: string };
          next: { tool: string; safe_to_run: boolean; command: string; arguments: { path?: string; project_id?: string } };
        };

        expect(doctor.project.ok).toBe(false);
        expect(doctor.project.error).toContain("Project id conflict");
        expect(doctor.next).toMatchObject({
          tool: "project_init",
          safe_to_run: false,
          command: `moryn project init --path ${project}`,
          arguments: {
            path: project
          }
        });
        expect(doctor.next.command).not.toContain("--project-id");
        expect(doctor.next.arguments).not.toHaveProperty("project_id");

        const start = await client.callTool({
          name: "agent_start",
          arguments: {
            project_path: project,
            project_id: "other",
            current_task: "avoid conflicting project id",
            agent: { client: "codex" }
          }
        });
        expect("isError" in start ? start.isError : false).toBe(true);
        const parsedStart = parseTextContent(start) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              candidate_project_ids?: string[];
              safe_to_run: boolean;
            };
          };
        };
        expect(parsedStart.ok).toBe(false);
        expect(parsedStart.error.code).toBe("PROJECT_ID_CONFLICT");
        expect(parsedStart.error.message).toContain("Project id conflict");
        expect(parsedStart.error.recommended_action).toBe("pass the project id from .moryn.json or update the project config");
        expect(parsedStart.error.next_action).toMatchObject({
          recommended_action: "retry_with_project_config_id_or_update_project_config",
          tool: "agent_enter",
          command: "moryn agent enter --project-id moryn",
          arguments: { project_id: "moryn" },
          rejected_arguments: { project_id: "other" },
          candidate_project_ids: ["moryn"],
          required_fields: [],
          safe_to_run: false
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects direct lifecycle MCP tools without project input in a populated store", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-direct-ambiguous-project-"));
    const store = join(root, "store");
    const unknownCwd = join(root, "unknown-cwd");
    try {
      await mkdir(unknownCwd, { recursive: true });
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Known direct MCP project.",
            source: { client: "codex", session_id: "codex-direct-project" }
          }
        });

        for (const { call, retry } of [
          {
            call: {
              name: "agent_start",
              arguments: {
                current_task: "avoid ambient project",
                agent: { client: "codex" }
              }
            },
            retry: {
              tool: "agent_start",
              command: "moryn agent start --current-task 'avoid ambient project' --agent codex --project-id <project_id_from_project_list>",
              arguments: { current_task: "avoid ambient project", agent: { client: "codex" }, project_id: "<project_id_from_project_list>" }
            }
          },
          {
            call: {
              name: "agent_status",
              arguments: {
                current_task: "avoid ambient project",
                status: "Do not write inferred status.",
                agent: { client: "codex" }
              }
            },
            retry: {
              tool: "agent_status",
              command: "moryn agent status --current-task 'avoid ambient project' --agent codex --status 'Do not write inferred status.' --project-id <project_id_from_project_list>",
              arguments: {
                current_task: "avoid ambient project",
                status: "Do not write inferred status.",
                agent: { client: "codex" },
                project_id: "<project_id_from_project_list>"
              }
            }
          },
          {
            call: {
              name: "agent_finish",
              arguments: {
                current_task: "avoid ambient project",
                summary: "Do not write inferred summary.",
                agent: { client: "codex" }
              }
            },
            retry: {
              tool: "agent_finish",
              command: "moryn agent finish --current-task 'avoid ambient project' --agent codex --summary 'Do not write inferred summary.' --project-id <project_id_from_project_list>",
              arguments: {
                current_task: "avoid ambient project",
                summary: "Do not write inferred summary.",
                agent: { client: "codex" },
                project_id: "<project_id_from_project_list>"
              }
            }
          }
        ]) {
          const result = await client.callTool(call);
          expect("isError" in result ? result.isError : false).toBe(true);
          const parsed = parseTextContent(result) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              next_action: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
                workflow?: {
                  phases?: Array<Record<string, unknown>>;
                };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("PROJECT_CONTEXT_REQUIRED");
          expect(parsed.error.message).toContain("Project context required");
          expect(parsed.error.recommended_action).toBe("run moryn project list or moryn agent enter, then retry with --project-id or --project");
          expect(parsed.error.next_action).toMatchObject({
            recommended_action: "discover_projects_before_lifecycle_write",
            tool: "project_list",
            command: "moryn project list",
            arguments: {},
            candidate_project_ids: ["moryn"],
            required_fields: [],
            safe_to_run: true
          });
          expect(parsed.error.next_action.workflow?.phases?.[1]).toEqual({
            phase: "retry_original_tool_with_selected_project_id",
            order: 2,
            action_source: "project_list.projects_by_id.<project_id>.project_id",
            tool: retry.tool,
            command: retry.command,
            arguments: retry.arguments,
            replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
            required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
            required_fields: ["project_id"]
          });
        }
      }, unknownCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured local lifecycle sync recovery details through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-local-sync-details-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await withMcpClient(store, async (client) => {
        const start = parseTextContent(await client.callTool({
          name: "agent_start",
          arguments: {
            project_path: project,
            current_task: "work locally with recovery details",
            agent: { client: "gemini", session_id: "gemini-local-sync-details" }
          }
        })) as {
          sync: {
            pull_error?: string;
            pull_error_details?: {
              code: string;
              recommended_action: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
              };
            };
          };
        };
        expect(start.sync.pull_error).toContain("Sync not configured");
        expect(start.sync.pull_error_details).toMatchObject({
          code: "SYNC_NOT_CONFIGURED",
          recommended_action: "run moryn sync init <remote>",
          next_action: {
            recommended_action: "configure_sync_remote",
            tool: "sync_init",
            command: "moryn sync init <remote>",
            arguments: { remote: "<remote>" },
            required_fields: ["remote"],
            argument_sources: {
              remote: "user_input.remote"
            },
            safe_to_run: false
          }
        });

        const finish = parseTextContent(await client.callTool({
          name: "agent_finish",
          arguments: {
            project_path: project,
            summary: "Local MCP handoff with sync recovery details.",
            agent: { client: "gemini", session_id: "gemini-local-sync-details" }
          }
        })) as {
          sync: {
            push_error?: string;
            push_error_details?: {
              code: string;
              recommended_action: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                required_fields: string[];
                safe_to_run: boolean;
              };
            };
          };
        };
        expect(finish.sync.push_error).toContain("Sync not configured");
        expect(finish.sync.push_error_details).toMatchObject({
          code: "SYNC_NOT_CONFIGURED",
          recommended_action: "run moryn sync init <remote>",
          next_action: {
            recommended_action: "configure_sync_remote",
            tool: "sync_init",
            command: "moryn sync init <remote>",
            arguments: { remote: "<remote>" },
            required_fields: ["remote"],
            argument_sources: {
              remote: "user_input.remote"
            },
            safe_to_run: false
          }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves project paths and project config through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, {
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: ["release"]
      });

      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const skill = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "skill",
            type: "procedure",
            scope: "global",
            tags: ["release"],
            text: "Release skill from project config.",
            state: "canonical",
            source: { client: "user" }
          }
        })) as { record: { id: string } };
        const decision = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_path: project,
            text: "MCP project path resolves config.",
            state: "canonical",
            source: { client: "mcp-project-test" }
          }
        })) as { record: { id: string; project_id?: string; tags: string[] } };

        expect(decision.record.project_id).toBe("moryn");
        expect(decision.record.tags).toContain("typescript");

        const boot = parseTextContent(await client.callTool({
          name: "boot",
          arguments: {
            project_path: project,
            current_task: "resolve config"
          }
        })) as { skills: Array<{ id: string }>; project: { important_decisions: Array<{ id: string }> }; task_relevant: Array<{ id: string }> };
        expect(boot.skills.map((record) => record.id)).toEqual([skill.record.id]);
        expect(boot.project.important_decisions.map((record) => record.id)).toEqual([decision.record.id]);
        expect(boot.task_relevant.map((record) => record.id)).toEqual([decision.record.id]);

        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { query: "project path", project_path: project }
        })) as { results: Array<{ record: { id: string; project_id?: string } }> };
        expect(recall.results[0]?.record.id).toBe(decision.record.id);
        expect(recall.results[0]?.record.project_id).toBe("moryn");

        const otherProject = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "other",
            text: "MCP retrieves this exact record across project context.",
            state: "canonical",
            source: { client: "mcp-project-test" }
          }
        })) as { record: { id: string } };
        const exactRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [otherProject.record.id], project_path: project }
        })) as { results: Array<{ record: { id: string; content: { text: string } } }> };
        expect(exactRecall.results[0]?.record.id).toBe(otherProject.record.id);
        expect(exactRecall.results[0]?.record.content.text).toBe("MCP retrieves this exact record across project context.");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists known projects through MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-project-list-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
        await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "alpha",
            text: "Alpha project memory.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        });
        await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "beta",
            text: "Beta final handoff.",
            source: { client: "codex", session_id: "codex-beta" }
          }
        });

        const listed = parseTextContent(await client.callTool({
          name: "project_list",
          arguments: {}
        })) as {
          projects: Array<{
            project_id: string;
            latest_activity: { text: string; agent: { client?: string; session_id?: string } };
            next: {
              recommended_action: string;
              tool: string;
              safe_to_run: boolean;
              command: string;
              required_when: string;
              required_fields: string[];
              arguments: { project_id: string };
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
              workflow?: Record<string, unknown>;
            };
          }>;
          projects_by_id: Record<string, {
            project_id: string;
            latest_activity: { text: string; agent: { client?: string; session_id?: string } };
            next: {
              workflow?: Record<string, unknown>;
              arguments: { project_id: string };
            };
          }>;
          selection_sources: Record<string, string>;
        };

        expect(listed.projects.map((project) => project.project_id)).toEqual(["beta", "alpha"]);
        expect(listed.selection_sources).toEqual({
          project: "projects_by_id.<project_id>",
          project_id: "projects_by_id.<project_id>.project_id",
          next_action: "projects_by_id.<project_id>.next"
        });
        expect(listed.projects_by_id.beta).toEqual(listed.projects[0]);
        expect(listed.projects_by_id.alpha).toEqual(listed.projects[1]);
        expect(listed.projects[0]).toMatchObject({
          project_id: "beta",
          latest_activity: {
            text: "Beta final handoff.",
            agent: { client: "codex", session_id: "codex-beta" }
          },
          next: {
            recommended_action: "call_agent_start",
            tool: "agent_start",
            safe_to_run: true,
            required_when: "After choosing this project from project_list results.",
            required_fields: [],
            arguments: { project_id: "beta" },
            selection_sources: {
              project: "project_list.projects_by_id.<project_id>",
              project_id: "project_list.projects_by_id.<project_id>.project_id",
              next_action: "project_list.projects_by_id.<project_id>.next",
              ordered_next_action: "project_list.projects[].next"
            }
          }
        });
        expectActionInterfaces(listed.projects[0]!.next);
        expectActionSafety(listed.projects[0]!.next);
        expectProjectListNextWorkflow(listed.projects[0]!.next);
        expect(listed.projects_by_id.beta.next.workflow).toEqual(listed.projects[0]!.next.workflow);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("initializes project config over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-project-init-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await withMcpClient(store, async (client) => {
        const init = parseTextContent(await client.callTool({
          name: "project_init",
          arguments: {
            path: project,
            project_id: "moryn",
            tags: ["typescript", "mcp"],
            default_skills: ["release"],
            sync_mode: "interval"
          }
        })) as { ok: boolean; config: { project_id: string; tags: string[]; default_skills: string[]; sync: { mode: string } } };

        expect(init.ok).toBe(true);
        expect(init.config).toMatchObject({
          project_id: "moryn",
          tags: ["typescript", "mcp"],
          default_skills: ["release"],
          sync: { mode: "interval" }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves existing project sync mode when MCP updates config without sync_mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-project-init-preserve-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await withMcpClient(store, async (client) => {
        parseTextContent(await client.callTool({
          name: "project_init",
          arguments: {
            path: project,
            project_id: "moryn",
            sync_mode: "interval"
          }
        }));
        const updated = parseTextContent(await client.callTool({
          name: "project_init",
          arguments: {
            path: project,
            tags: ["typescript"]
          }
        })) as { ok: boolean; config: { tags: string[]; sync: { mode: string } } };

        expect(updated.ok).toBe(true);
        expect(updated.config.tags).toEqual(["typescript"]);
        expect(updated.config.sync.mode).toBe("interval");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs malformed project config over MCP when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-project-init-repair-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":", "utf8");

      await withMcpClient(store, async (client) => {
        const repaired = parseTextContent(await client.callTool({
          name: "project_init",
          arguments: {
            path: project,
            project_id: "moryn",
            tags: ["typescript"],
            sync_mode: "manual",
            repair: true
          }
        })) as { ok: boolean; config: { project_id: string; tags: string[]; sync: { mode: string } } };

        expect(repaired.ok).toBe(true);
        expect(repaired.config).toMatchObject({
          project_id: "moryn",
          tags: ["typescript"],
          sync: { mode: "manual" }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply ambient project config when only project_id is provided over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-explicit-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, {
        project_id: "ambient",
        tags: ["ambient-tag"],
        default_skills: ["ambient-skill"]
      });

      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "explicit",
            text: "Explicit MCP project id should stand alone."
          }
        })) as { record: { project_id?: string; tags: string[] } };

        expect(write.record.project_id).toBe("explicit");
        expect(write.record.tags).toEqual([]);
      }, project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors from MCP tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-mcp-error-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");

      await withMcpClient(store, async (client) => {
        const response = await client.callTool({
          name: "boot",
          arguments: { project_path: project }
        });
        expect("isError" in response ? response.isError : false).toBe(true);
        const result = parseTextContent(response) as { ok: boolean; error: { code: string; recoverable: boolean } };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("INVALID_PROJECT_CONFIG");
        expect(result.error.recoverable).toBe(true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns store initialization recovery actions from MCP errors", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-uninitialized-"));
    try {
      await withMcpClient(store, async (client) => {
        const response = await client.callTool({
          name: "boot",
          arguments: { project_id: "moryn" }
        });
        expect("isError" in response ? response.isError : false).toBe(true);
        const result = parseTextContent(response) as {
          ok: boolean;
          error: {
            code: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("STORE_NOT_INITIALIZED");
        expect(result.error.next_action).toMatchObject({
          recommended_action: "initialize_store",
          tool: "init",
          command: "moryn init",
          arguments: {},
          required_fields: [],
          safe_to_run: false
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns guarded repair actions for malformed store config over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-invalid-store-config-"));
    try {
      await writeFile(join(store, "config.json"), "{\"store_version\":", "utf8");

      await withMcpClient(store, async (client) => {
        const response = await client.callTool({ name: "init", arguments: {} });
        expect("isError" in response ? response.isError : false).toBe(true);
        const result = parseTextContent(response) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("INVALID_STORE_CONFIG");
        expect(result.error.recommended_action).toBe("fix or repair config.json, then run moryn init");
        expect(result.error.next_action).toMatchObject({
          recommended_action: "repair_local_store_config",
          tool: "init",
          command: "moryn init --repair",
          arguments: { repair: true },
          required_fields: [],
          safe_to_run: false
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("repairs malformed store config over MCP when explicitly requested", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-repair-store-config-"));
    try {
      await writeFile(join(store, "config.json"), "{\"store_version\":", "utf8");

      await withMcpClient(store, async (client) => {
        const repaired = parseTextContent(await client.callTool({ name: "init", arguments: { repair: true } })) as {
          ok: boolean;
          config: { store_version: number; device_id: string };
        };

        expect(repaired.ok).toBe(true);
        expect(repaired.config.store_version).toBe(1);
        expect(repaired.config.device_id).toMatch(/^device_/);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for missing record mutations over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-missing-record-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const result = parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: "rec_missing",
            reason: "Should fail"
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              required_when?: string;
              required_fields: string[];
              workflow?: Record<string, unknown>;
              safety?: {
                safe_to_auto_run?: boolean;
                requires_user_confirmation?: boolean;
                requires_authored_input?: boolean;
                writes_local_config?: boolean;
                reasons?: string[];
              };
              safe_to_run: boolean;
            };
          };
        };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("RECORD_NOT_FOUND");
        expect(result.error.recoverable).toBe(true);
        expect(result.error.recommended_action).toBe("check the record id or call recall/list-recent to find it");
        expect(result.error.next_action).toMatchObject({
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          rejected_arguments: { record_id: "rec_missing" },
          required_fields: [],
          safe_to_run: true
        });
        expect(result.error.next_action?.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "archive",
          command: "moryn archive <record_id_from_list_recent> --reason 'Should fail'",
          arguments: { record_id: "<record_id_from_list_recent>", reason: "Should fail" },
          replace_arguments: { record_id: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_id"]
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns retry workflow context for missing recall record ids over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-missing-recall-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const result = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: ["rec_missing"]
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            next_action?: {
              workflow?: {
                phases?: Array<Record<string, unknown>>;
              };
            };
          };
        };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("RECORD_NOT_FOUND");
        expect(result.error.next_action?.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "recall",
          command: "moryn recall --record-id <record_id_from_list_recent>",
          arguments: { record_ids: ["<record_id_from_list_recent>"] },
          replace_arguments: { record_ids: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_ids"]
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for managed-field revisions over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-managed-revision-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Use promote for MCP state transitions.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const result = parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: write.record.id,
            patch: { state: "canonical" },
            reason: "Bypass promotion",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("INVALID_ARGUMENT");
        expect(result.error.message).toContain("managed field state");
        expect(result.error.recommended_action).toBe("fix the command arguments and retry");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for invalid revision patches over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-invalid-revision-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Keep MCP revision patches valid.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        for (const patch of [
          { "content.text": "" },
          {},
          { "": "Invalid patch path" },
          { ".content.text": "Invalid patch path" },
          { "content..text": "Invalid patch path" },
          { "content.text.": "Invalid patch path" }
        ]) {
          const result = parseTextContent(await client.callTool({
            name: "revise",
            arguments: {
              record_id: write.record.id,
              patch,
              reason: "Invalid revision patch",
              source: { client: "mcp-test" }
            }
          })) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };

          expect(result.ok).toBe(false);
          expect(result.error.code).toBe("INVALID_ARGUMENT");
          expect(result.error.message).toContain("Invalid patch");
          expect(result.error.recommended_action).toBe("fix the command arguments and retry");
        }
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for high-risk canonical changes", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-confirm-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "soul",
            type: "preference",
            scope: "global",
            text: "Prefer terse answers.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as {
          record: { id: string; state: string };
          warning?: {
            code: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(write.record.state).toBe("candidate");
        expect(write.warning?.code).toBe("CONFIRMATION_REQUIRED");
        expect(write.warning?.next_action).toMatchObject({
          recommended_action: "ask_user_then_promote_candidate",
          tool: "promote",
          command: `moryn promote ${write.record.id} --state canonical --reason 'User confirmed' --confirm`,
          candidate_record_id: write.record.id,
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true
          },
          argument_sources: {
            record_id: "write.record.id"
          },
          required_fields: [],
          safe_to_run: false
        });
        expectCandidatePromoteWorkflow(write.warning!.next_action!);

        const memoryPreference = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "preference",
            scope: "global",
            text: "Prefer concise MCP updates.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { state: string }; warning?: { code: string } };
        expect(memoryPreference.record.state).toBe("candidate");
        expect(memoryPreference.warning?.code).toBe("CONFIRMATION_REQUIRED");

        const rejected = parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "Agent inferred this preference",
            source: { client: "mcp-test" }
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(rejected.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: `moryn promote ${write.record.id} --state canonical --reason 'Agent inferred this preference' --confirm`,
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "Agent inferred this preference",
            source: { client: "mcp-test" },
            confirmed: true
          },
          required_fields: [],
          safe_to_run: false
        });

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [write.record.id] }
        })) as { results: Array<{ record: { state: string } }> };
        expect(recall.results[0]?.record.state).toBe("canonical");

        const confirmedWrite = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "skill",
            type: "procedure",
            scope: "global",
            text: "Global release checklist.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { state: string }; warning?: unknown };
        expect(confirmedWrite.record.state).toBe("canonical");
        expect(confirmedWrite.warning).toBeUndefined();
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("writes provenance over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-provenance-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Use provenance metadata.",
            state: "candidate",
            provenance: {
              derived_from: ["rec_source"],
              reason: "Derived from handoff summary."
            },
            source: { client: "mcp-test" }
          }
        })) as { record: { provenance?: { derived_from?: string[]; reason?: string; method?: string } } };

        expect(write.record.provenance).toEqual({
          derived_from: ["rec_source"],
          reason: "Derived from handoff summary.",
          method: "agent-proposed"
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("uses MCP as the default source for mutation events", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-default-source-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const target = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "MCP mutation source target.",
            state: "candidate"
          }
        })) as { record: { id: string }; selection_sources: Record<string, string> };
        const linked = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "MCP mutation source linked record.",
            state: "candidate"
          }
        })) as { record: { id: string }; selection_sources: Record<string, string> };

        expect(target.selection_sources).toEqual(WRITE_SELECTION_SOURCES);
        expect(linked.selection_sources).toEqual(WRITE_SELECTION_SOURCES);

        const revised = parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { "content.text": "MCP mutation source revised target." },
            reason: "Default MCP source"
          }
        })) as { event: { record_id: string }; selection_sources: Record<string, string> };
        const promoted = parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: target.record.id,
            target_state: "canonical",
            reason: "Default MCP source"
          }
        })) as { event: { record_id: string }; selection_sources: Record<string, string> };
        const link = parseTextContent(await client.callTool({
          name: "link",
          arguments: {
            record_id: target.record.id,
            linked_record_id: linked.record.id,
            link_type: "related"
          }
        })) as { event: { record_id: string; linked_record_id: string }; selection_sources: Record<string, string> };
        const archived = parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: linked.record.id,
            reason: "Default MCP source"
          }
        })) as { event: { record_id: string }; selection_sources: Record<string, string> };
        const quarantined = parseTextContent(await client.callTool({
          name: "quarantine",
          arguments: {
            record_id: target.record.id,
            reason: "Default MCP source"
          }
        })) as { event: { record_id: string }; selection_sources: Record<string, string> };

        expect(revised.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
        expect(promoted.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
        expect(link.selection_sources).toEqual(LINK_EVENT_SELECTION_SOURCES);
        expect(link.event.linked_record_id).toBe(linked.record.id);
        expect(archived.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
        expect(quarantined.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);

        const events = await readEvents(store);
        const mutationClients = events
          .filter((event) => event.op !== "upsert_record")
          .map((event) => event.source.client);
        expect(mutationClients).toEqual(["mcp", "mcp", "mcp", "mcp", "mcp"]);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous MCP write content inputs", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-content-input-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const both = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            text: "Plain text",
            content: { text: "Structured text", format: "json" },
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(both.ok).toBe(false);
        expect(both.error.code).toBe("INVALID_ARGUMENT");
        expect(both.error.message).toContain("either text or content");

        const neither = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(neither.ok).toBe(false);
        expect(neither.error.code).toBe("INVALID_ARGUMENT");
        expect(neither.error.message).toContain("text or content");

        const emptyContent = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            content: {},
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(emptyContent.ok).toBe(false);
        expect(emptyContent.error.code).toBe("INVALID_ARGUMENT");
        expect(emptyContent.error.message).toContain("Invalid content");

        const emptyStructuredText = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            content: { text: "", format: "json" },
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(emptyStructuredText.ok).toBe(false);
        expect(emptyStructuredText.error.code).toBe("INVALID_ARGUMENT");
        expect(emptyStructuredText.error.message).toContain("Invalid content.text");

        const missingProject = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            text: "Project records need an explicit project context.",
            source: { client: "mcp-test" }
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(missingProject.ok).toBe(false);
        expect(missingProject.error.code).toBe("INVALID_ARGUMENT");
        expect(missingProject.error.message).toContain("project_id is required for project scope");
        expect(missingProject.error.next_action).toMatchObject({
          recommended_action: "discover_project_context_before_project_scoped_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          rejected_arguments: { scope: "project" },
          required_fields: [],
          safe_to_run: true
        });
        expectRecoveryWorkflow(missingProject.error.next_action!);
        expect(await readEvents(store)).toHaveLength(0);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("surfaces structured JSON content without text through MCP boot refresh and recall", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-structured-content-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const summary = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "summary",
            scope: "project",
            project_id: "moryn",
            state: "canonical",
            content: {
              format: "json",
              summary: "MCP structured boot summary."
            }
          }
        })) as { record: { id: string } };
        const warning = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "warning",
            scope: "project",
            project_id: "moryn",
            state: "canonical",
            content: {
              format: "json",
              summary: "MCP structured warning.",
              files: ["src/mcp/server.ts"],
              evidence: ["mcp-structured"]
            }
          }
        })) as { record: { id: string } };

        const boot = parseTextContent(await client.callTool({
          name: "boot",
          arguments: { project_id: "moryn" }
        })) as { project: { summary: string; warnings: Array<{ id: string }>; warnings_by_id: Record<string, { id: string }> } };
        const refresh = parseTextContent(await client.callTool({
          name: "refresh",
          arguments: {
            project_id: "moryn",
            cursor: "2000-01-01T00:00:00.000Z"
          }
        })) as { changes: Array<{ record_id: string; summary: string }> };
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            query: "mcp-structured",
            project_id: "moryn"
          }
        })) as { results: Array<{ record: { id: string }; reason: string[] }> };

        expect(boot.project.summary).toBe("MCP structured boot summary.");
        expect(boot.project.warnings.map((record) => record.id)).toContain(warning.record.id);
        expect(boot.project.warnings_by_id[warning.record.id]?.id).toBe(warning.record.id);
        expect(refresh.changes).toContainEqual(expect.objectContaining({
          record_id: summary.record.id,
          summary: "MCP structured boot summary."
        }));
        expect(refresh.changes).toContainEqual(expect.objectContaining({
          record_id: warning.record.id,
          summary: "MCP structured warning. src/mcp/server.ts mcp-structured"
        }));
        expect(recall.results[0]?.record.id).toBe(warning.record.id);
        expect(recall.results[0]?.reason).toContain("text_match:mcp-structured");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("writes project session summaries with handoff defaults over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-session-summary-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "session_summary",
            project_id: "moryn",
            text: "Finished the task summary."
          }
        })) as {
          record: {
            kind: string;
            type: string;
            scope: string;
            project_id?: string;
            state: string;
            content: { text?: string };
            source: { client: string };
          };
        };

        expect(write.record).toMatchObject({
          kind: "session_summary",
          type: "summary",
          scope: "project",
          project_id: "moryn",
          state: "candidate",
          content: { text: "Finished the task summary." },
          source: { client: "mcp" }
        });

        const missingType = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            scope: "project",
            project_id: "moryn",
            text: "Ordinary MCP memories still need a type."
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(missingType.ok).toBe(false);
        expect(missingType.error.code).toBe("INVALID_ARGUMENT");
        expect(missingType.error.message).toContain("write requires type");

        const missingScope = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            project_id: "moryn",
            text: "Ordinary MCP memories still need a scope."
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(missingScope.ok).toBe(false);
        expect(missingScope.error.code).toBe("INVALID_ARGUMENT");
        expect(missingScope.error.message).toContain("write requires scope");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("rejects empty optional MCP string inputs at the schema boundary", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-empty-input-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "moryn",
              text: "",
              source: { client: "mcp-test" }
            }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "moryn",
              text: "Valid text",
              tags: [""],
              source: { client: "mcp-test" }
            }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "recall",
            arguments: { project_id: "moryn", query: "" }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "refresh",
            arguments: { project_id: "moryn", cursor: "" }
          }),
          /Invalid arguments/
        );
        const invalidCursor = parseTextContent(await client.callTool({
          name: "refresh",
          arguments: { project_id: "moryn", cursor: "not-a-date" }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(invalidCursor.ok).toBe(false);
        expect(invalidCursor.error.code).toBe("INVALID_ARGUMENT");
        expect(invalidCursor.error.message).toContain("Invalid cursor");
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "promote",
            arguments: { record_id: "rec_missing", target_state: "canonical", reason: "" }
          }),
          /Invalid arguments/
        );
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("marks conflicting MCP canonical writes as candidates", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const conflicting = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use SQLite as the source of truth.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as {
          record: { state: string; conflict?: { with: string[]; resolution: string } };
          warning?: {
            code: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              argument_sources?: Record<string, string>;
              candidate_record_id?: string;
              selection_sources?: Record<string, string>;
              required_when?: string;
              required_fields: string[];
              workflow?: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };

        expect(conflicting.record.state).toBe("candidate");
        expect(conflicting.warning?.code).toBe("CONFIRMATION_REQUIRED");
        expect(conflicting.warning?.next_action).toMatchObject({
          recommended_action: "ask_user_then_promote_candidate",
          tool: "promote",
          command: expect.stringMatching(/^moryn promote rec_[a-f0-9]+ --state canonical --reason 'User confirmed' --confirm$/),
          candidate_record_id: expect.stringMatching(/^rec_[a-f0-9]+$/),
          arguments: expect.objectContaining({
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true
          }),
          argument_sources: {
            record_id: "write.record.id"
          },
          required_fields: [],
          safe_to_run: false
        });
        expect(conflicting.warning!.next_action!.arguments.record_id).toBe(conflicting.warning!.next_action!.candidate_record_id);
        expectCandidatePromoteWorkflow(conflicting.warning!.next_action!);
        expectNextActionSelectionSources(conflicting.warning!.next_action!);
        expectActionSafety(conflicting.warning!.next_action!);
        expect(conflicting.warning!.next_action!.safety).toMatchObject({
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          requires_authored_input: false,
          writes_local_config: false,
          reasons: expect.arrayContaining(["requires_user_confirmation"])
        });
        expect(conflicting.record.conflict?.with).toEqual([existing.record.id]);
        expect(conflicting.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for conflicting canonical promotion", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-promote-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const candidate = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use SQLite as the source of truth.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };
        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const rejected = parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: candidate.record.id,
            target_state: "canonical",
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" }
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(rejected.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: `moryn promote ${candidate.record.id} --state canonical --reason 'Agent inferred this replacement' --confirm`,
          arguments: {
            record_id: candidate.record.id,
            target_state: "canonical",
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" },
            confirmed: true
          },
          required_fields: [],
          safe_to_run: false
        });

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: candidate.record.id,
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [candidate.record.id] }
        })) as { results: Array<{ record: { state: string; conflict?: { with: string[]; resolution: string } } }> };
        expect(recall.results[0]?.record.state).toBe("canonical");
        expect(recall.results[0]?.record.conflict?.with).toEqual([existing.record.id]);
        expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for conflicting canonical revisions", async () => {
    const store = await mkdtemp(join(tmpdir(), "moryn-mcp-revise-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };
        const target = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "warning",
            scope: "project",
            project_id: "moryn",
            tags: ["sync"],
            text: "Use private Git remotes.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const rejected = parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" }
          }
        })) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(rejected.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "revise",
          command: `moryn revise ${target.record.id} --set type=decision --set 'content.text=Use SQLite as the source of truth.' --reason 'Agent inferred this replacement' --confirm`,
          arguments: {
            record_id: target.record.id,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" },
            confirmed: true
          },
          required_fields: [],
          safe_to_run: false
        });

        parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [target.record.id] }
        })) as { results: Array<{ record: { type: string; content: { text: string }; conflict?: { with: string[]; resolution: string } } }> };
        expect(recall.results[0]?.record.type).toBe("decision");
        expect(recall.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
        expect(recall.results[0]?.record.conflict?.with).toEqual([existing.record.id]);
        expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
