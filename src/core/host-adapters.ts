import { agentStart } from "./agent-lifecycle.js";
import { evaluateAutocapturePolicy, type AutocapturePolicyResult } from "./autocapture-policy.js";
import { createEngine } from "./engine.js";
import { getHostAdapter, getHostAdapters, normalizeHostId, type HostAdapter, type HostAdapterId } from "./host-adapter-registry.js";
import { resolveProjectContext } from "./project.js";
import type { MorynRecord, RecordSource } from "./types.js";

export { getHostAdapter, getHostAdapters, normalizeHostId, type HostAdapter, type HostAdapterId };

export type InstallPlanAction = {
  action: "initialize_store" | "initialize_project" | "register_mcp" | "configure_lifecycle_hooks" | "context_pack" | "capture_session";
  title: string;
  command: string;
  safe_to_auto_run: boolean;
  writes: "none" | "moryn_store" | "project_config";
  adapter?: HostAdapterId;
};

export type InstallPlan = {
  mode: "dry_run" | "apply";
  host: HostAdapterId | "all";
  project_path?: string;
  sync_remote?: string;
  adapters: HostAdapter[];
  actions: InstallPlanAction[];
  actions_by_id: Record<string, InstallPlanAction>;
  warnings: string[];
  next: {
    recommended_action: "run_context_pack";
    command: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof INSTALL_PLAN_SELECTION_SOURCES;
};

export type InstallPlanInput = {
  host?: string;
  projectPath?: string;
  syncRemote?: string;
  apply?: boolean;
};

export type CaptureSessionInput = {
  storePath: string;
  projectPath?: string;
  projectId?: string;
  syncRemote?: string;
  summary: string;
  currentTask?: string;
  files?: string[];
  agent?: Partial<RecordSource>;
};

export type CaptureSessionResult = {
  ok: true;
  mode: "capture_session";
  adapter: HostAdapter;
  record: MorynRecord;
  policy_decision: AutocapturePolicyResult;
  next: {
    recommended_action: "run_context_pack";
    command: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof CAPTURE_SESSION_SELECTION_SOURCES;
};

export type ContextPackInput = {
  storePath: string;
  projectPath?: string;
  projectId?: string;
  syncRemote?: string;
  currentTask?: string;
  agent?: Partial<RecordSource>;
  limit?: number;
  includePrivate?: boolean;
  pull?: boolean;
};

export type ContextPackResult = {
  ok: true;
  kind: "context_pack";
  adapter: HostAdapter;
  agent: RecordSource;
  project: Record<string, unknown>;
  handoff_pack: HandoffPackV2;
  sections: {
    boot: unknown;
    refresh: unknown;
    handoff: {
      inbox: Array<{ text: string }>;
      active_sessions: unknown[];
      [key: string]: unknown;
    };
  };
  lifecycle: unknown;
  next: {
    required_end_action_id: "capture_session";
    required_end_action_source: "next.actions_by_id.capture_session";
    recommended_refresh_action_id?: string;
    actions: unknown[];
    actions_by_id: Record<string, unknown>;
    selection_sources: typeof CONTEXT_PACK_NEXT_SELECTION_SOURCES;
  };
  selection_sources: typeof CONTEXT_PACK_SELECTION_SOURCES;
};

export type HandoffPackEvidence = {
  source: string;
  record_id?: string;
  command?: string;
};

export type HandoffPackItem = {
  text: string;
  evidence: HandoffPackEvidence;
};

export type HandoffPackNextAction = {
  id: string;
  command?: string;
  required_when?: string;
  evidence: HandoffPackEvidence;
};

export type HandoffQualityGateCheckId =
  | "current_goal"
  | "recent_decisions"
  | "open_threads"
  | "risks"
  | "evidence_paths"
  | "capture_next_action";

export type HandoffQualityGateCheck = {
  id: HandoffQualityGateCheckId;
  status: "pass" | "warn";
  label: string;
  source: string;
  count?: number;
  message: string;
};

export type HandoffQualityGate = {
  status: "ready" | "needs_review";
  read_only: true;
  checks: HandoffQualityGateCheck[];
  checks_by_id: Record<HandoffQualityGateCheckId, HandoffQualityGateCheck>;
  failed_check_ids: HandoffQualityGateCheckId[];
  warnings: string[];
  selection_sources: typeof HANDOFF_QUALITY_GATE_SELECTION_SOURCES;
};

type HandoffPackWithoutQualityGate = Omit<HandoffPackV2, "quality_gate" | "selection_sources">;

export type HandoffPackV2 = {
  version: 2;
  purpose: "agent_handoff";
  current_goal?: {
    text: string;
    source: "context_pack.current_task";
  };
  recent_decisions: HandoffPackItem[];
  open_threads: HandoffPackItem[];
  important_files: HandoffPackItem[];
  risks: HandoffPackItem[];
  user_preferences: HandoffPackItem[];
  next_actions: HandoffPackNextAction[];
  evidence: {
    boot: "sections.boot";
    refresh: "sections.refresh";
    handoff: "sections.handoff";
    next: "next";
  };
  quality_gate: HandoffQualityGate;
  selection_sources: typeof HANDOFF_PACK_SELECTION_SOURCES;
};

export const INSTALL_PLAN_SELECTION_SOURCES = {
  adapter: "adapters[]",
  action: "actions_by_id.<action>",
  ordered_action: "actions[]",
  next: "next",
  warning: "warnings[]"
} as const;

export const CAPTURE_SESSION_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  adapter: "adapter",
  policy_decision: "policy_decision",
  policy_decision_id: "policy_decision.policy_id",
  policy_decision_action: "policy_decision.decision",
  next: "next"
} as const;

export const CONTEXT_PACK_SELECTION_SOURCES = {
  context_pack: "context_pack",
  handoff_pack: "handoff_pack",
  project: "project",
  boot: "sections.boot",
  refresh: "sections.refresh",
  handoff: "sections.handoff",
  next: "next"
} as const;

export const CONTEXT_PACK_NEXT_SELECTION_SOURCES = {
  action: "next.actions_by_id.<action>",
  ordered_action: "next.actions[]",
  capture_session: "next.actions_by_id.capture_session"
} as const;

export const HANDOFF_PACK_SELECTION_SOURCES = {
  handoff_pack: "handoff_pack",
  current_goal: "handoff_pack.current_goal",
  recent_decision: "handoff_pack.recent_decisions[]",
  open_thread: "handoff_pack.open_threads[]",
  important_file: "handoff_pack.important_files[]",
  risk: "handoff_pack.risks[]",
  user_preference: "handoff_pack.user_preferences[]",
  next_action: "handoff_pack.next_actions[]",
  evidence: "handoff_pack.evidence",
  quality_gate: "handoff_pack.quality_gate"
} as const;

export const HANDOFF_QUALITY_GATE_SELECTION_SOURCES = {
  quality_gate: "handoff_pack.quality_gate",
  check: "handoff_pack.quality_gate.checks_by_id.<check_id>",
  ordered_check: "handoff_pack.quality_gate.checks[]",
  failed_check: "handoff_pack.quality_gate.failed_check_ids[]",
  warning: "handoff_pack.quality_gate.warnings[]"
} as const;

export function planInstall(input: InstallPlanInput = {}): InstallPlan {
  const normalizedHost = input.host ? normalizeHostId(input.host) : "all";
  const adapters = normalizedHost === "all"
    ? getHostAdapters()
    : getHostAdapters().filter((adapter) => adapter.id === normalizedHost);
  const projectPath = input.projectPath;
  const syncRemote = input.syncRemote;
  const firstAdapter = adapters[0] ?? getHostAdapter("shell")!;
  const agent = normalizedHost === "all" ? firstAdapter.normalized_client : normalizedHost;
  const projectArgs = projectPath ? ` --project ${quoteCli(projectPath)}` : "";
  const syncArgs = syncRemote ? ` --sync-remote ${quoteCli(syncRemote)}` : "";
  const currentTask = "<current task>";
  const actions: InstallPlanAction[] = [
    {
      action: "initialize_store",
      title: "Initialize the local Moryn store",
      command: "moryn init",
      safe_to_auto_run: true,
      writes: "moryn_store"
    }
  ];

  if (projectPath) {
    actions.push({
      action: "initialize_project",
      title: "Attach this repository as a Moryn project",
      command: `moryn project init --path ${quoteCli(projectPath)}`,
      safe_to_auto_run: true,
      writes: "project_config"
    });
  }

  for (const adapter of adapters) {
    actions.push({
      action: "register_mcp",
      title: `Register Moryn MCP for ${adapter.display_name}`,
      command: adapter.mcp_registration.command,
      safe_to_auto_run: false,
      writes: "none",
      adapter: adapter.id
    });
    actions.push({
      action: "configure_lifecycle_hooks",
      title: `Generate Moryn lifecycle hooks for ${adapter.display_name}`,
      command: projectPath && (adapter.id === "codex" || adapter.id === "claude")
        ? `moryn install --host ${adapter.id} --project ${quoteCli(projectPath)} --apply`
        : adapter.lifecycle_prompt,
      safe_to_auto_run: Boolean(projectPath && (adapter.id === "codex" || adapter.id === "claude")),
      writes: projectPath && (adapter.id === "codex" || adapter.id === "claude") ? "project_config" : "none",
      adapter: adapter.id
    });
    actions.push({
      action: "context_pack",
      title: `Start ${adapter.display_name} with Moryn context`,
      command: `moryn context pack${projectArgs}${syncArgs} --current-task ${quoteCli(currentTask)} --agent ${adapter.normalized_client}`,
      safe_to_auto_run: true,
      writes: "none",
      adapter: adapter.id
    });
    actions.push({
      action: "capture_session",
      title: `Capture ${adapter.display_name} session handoff`,
      command: `moryn capture session${projectArgs}${syncArgs} --agent ${adapter.normalized_client} --summary ${quoteCli("<summary>")}`,
      safe_to_auto_run: true,
      writes: "moryn_store",
      adapter: adapter.id
    });
  }

  const actionsById = Object.fromEntries(actions.map((action) => [action.action, action]));
  const warnings = [
    "Moryn writes only project-local Moryn-owned hook fragments; merge into the host main configuration explicitly.",
    "Git sync is configured only when a sync remote is supplied by the user."
  ];
  const nextCommand = `moryn context pack${projectArgs}${syncArgs} --current-task ${quoteCli(currentTask)} --agent ${agent}`;

  return {
    mode: input.apply ? "apply" : "dry_run",
    host: normalizedHost,
    project_path: projectPath,
    sync_remote: syncRemote,
    adapters,
    actions,
    actions_by_id: actionsById,
    warnings,
    next: {
      recommended_action: "run_context_pack",
      command: nextCommand,
      safe_to_run: true
    },
    selection_sources: INSTALL_PLAN_SELECTION_SOURCES
  };
}

export async function captureSession(input: CaptureSessionInput): Promise<CaptureSessionResult> {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("Invalid argument: --summary must not be empty");
  }
  const files = uniqueNonEmptyStrings(input.files);
  const adapter = getHostAdapter(input.agent?.client) ?? getHostAdapter("shell")!;
  const project = await resolveProjectContext({
    projectPath: input.projectPath,
    projectId: input.projectId
  });
  const source: RecordSource = {
    client: adapter.normalized_client,
    session_id: input.agent?.session_id,
    model: input.agent?.model,
    device_id: input.agent?.device_id
  };
  const engine = createEngine({ storePath: input.storePath });
  const existing = await engine.recall({
    query: summary,
    project_id: project.project_id,
    states: ["candidate", "archived"],
    tags: ["autocapture"],
    limit: 20
  });
  const policyDecision = evaluateAutocapturePolicy({
    summary,
    project_id: project.project_id,
    host: adapter.normalized_client,
    current_task: input.currentTask,
    existing_records: existing.results.map((result) => result.record)
  });
  const written = await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: project.project_id,
    tags: policyDecision.tags,
    content: {
      format: "json",
      text: summary,
      capture: {
        mode: "autocapture",
        host: adapter.normalized_client,
        adapter: adapter.id,
        session_id: input.agent?.session_id,
        project_path: project.project_path,
        current_task: input.currentTask,
        ...(files.length ? { files } : {}),
        policy: {
          id: policyDecision.policy_id,
          version: policyDecision.version,
          decision: policyDecision.decision,
          route: policyDecision.route,
          review_required: policyDecision.review_required,
          user_action_required: policyDecision.user_action_required,
          auto_canonical: policyDecision.auto_canonical,
          dashboard_surface: policyDecision.dashboard_surface,
          rule_ids: policyDecision.rule_ids,
          reasons: policyDecision.reasons,
          ...(policyDecision.duplicate_of_record_id ? { duplicate_of_record_id: policyDecision.duplicate_of_record_id } : {})
        }
      }
    },
    state: policyDecision.target_state,
    confidence: policyDecision.confidence,
    source,
    provenance: {
      method: "agent-proposed",
      reason: policyDecision.decision === "archive"
        ? `Autocapture policy archived this handoff: ${policyDecision.reasons.join(", ")}.`
        : policyDecision.decision === "capture"
          ? "Autocapture policy retained this low-risk handoff without canonical promotion."
          : "Captured through Moryn host adapter autocapture."
    }
  });

  const projectArg = input.projectId
    ? ` --project-id ${quoteCli(input.projectId)}`
    : input.projectPath
      ? ` --project ${quoteCli(input.projectPath)}`
      : "";
  const taskArg = input.currentTask ? ` --current-task ${quoteCli(input.currentTask)}` : "";
  const syncArg = input.syncRemote ? ` --sync-remote ${quoteCli(input.syncRemote)}` : "";
  return {
    ok: true,
    mode: "capture_session",
    adapter,
    record: written.record,
    policy_decision: policyDecision,
    next: {
      recommended_action: "run_context_pack",
      command: `moryn context pack${projectArg}${syncArg}${taskArg} --agent ${adapter.normalized_client}`,
      safe_to_run: true
    },
    selection_sources: CAPTURE_SESSION_SELECTION_SOURCES
  };
}

function uniqueNonEmptyStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export async function contextPack(input: ContextPackInput): Promise<ContextPackResult> {
  const adapter = getHostAdapter(input.agent?.client) ?? getHostAdapter("shell")!;
  const agent: RecordSource = {
    client: adapter.normalized_client,
    session_id: input.agent?.session_id,
    model: input.agent?.model,
    device_id: input.agent?.device_id
  };
  const started = await agentStart({
    storePath: input.storePath,
    projectPath: input.projectPath,
    projectId: input.projectId,
    syncRemote: input.syncRemote,
    currentTask: input.currentTask,
    limit: input.limit,
    includePrivate: input.includePrivate,
    pull: input.pull,
    agent
  });
  const projectArg = input.projectId
    ? ` --project-id ${quoteCli(input.projectId)}`
    : input.projectPath
      ? ` --project ${quoteCli(input.projectPath)}`
      : "";
  const taskArg = input.currentTask ? ` --current-task ${quoteCli(input.currentTask)}` : "";
  const syncArg = input.syncRemote ? ` --sync-remote ${quoteCli(input.syncRemote)}` : "";
  const captureAction = {
    action: "capture_session",
    tool: "capture_session",
    safe_to_run: true,
    required_when: "Before ending the host session, capture a handoff summary for other agents and devices.",
    required_fields: ["summary"],
    command: `moryn capture session${projectArg}${syncArg}${taskArg} --agent ${adapter.normalized_client} --summary <summary>`,
    arguments: {
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.projectPath ? { project_path: input.projectPath } : {}),
      ...(input.syncRemote ? { sync_remote: input.syncRemote } : {}),
      ...(input.currentTask ? { current_task: input.currentTask } : {}),
      agent,
      summary: "<summary>"
    }
  };
  const actions = [captureAction, ...started.next.actions];
  const actionsById = {
    capture_session: captureAction,
    ...started.next.actions_by_id
  };
  const next = {
    required_end_action_id: "capture_session" as const,
    required_end_action_source: "next.actions_by_id.capture_session" as const,
    recommended_refresh_action_id: started.next.recommended_refresh_action_id,
    actions,
    actions_by_id: actionsById,
    selection_sources: CONTEXT_PACK_NEXT_SELECTION_SOURCES
  };
  const sections = {
    boot: started.boot,
    refresh: started.refresh,
    handoff: started.handoff
  };

  return {
    ok: true,
    kind: "context_pack",
    adapter,
    agent,
    project: started.project as unknown as Record<string, unknown>,
    handoff_pack: buildHandoffPackV2({
      currentTask: input.currentTask,
      sections,
      next
    }),
    sections,
    lifecycle: started.next.workflow,
    next,
    selection_sources: CONTEXT_PACK_SELECTION_SOURCES
  };
}

function buildHandoffPackV2(input: {
  currentTask?: string;
  sections: ContextPackResult["sections"];
  next: ContextPackResult["next"];
}): HandoffPackV2 {
  const packWithoutQualityGate: HandoffPackWithoutQualityGate = {
    version: 2,
    purpose: "agent_handoff",
    ...(input.currentTask ? { current_goal: { text: input.currentTask, source: "context_pack.current_task" as const } } : {}),
    recent_decisions: handoffItems(
      recordsAtPath(input.sections.boot, ["project", "important_decisions"]),
      "sections.boot.project.important_decisions[]"
    ),
    open_threads: [
      ...handoffItems(recordsAtPath(input.sections.handoff, ["active_sessions"]), "sections.handoff.active_sessions[]"),
      ...handoffItems(recordsAtPath(input.sections.handoff, ["inbox"]), "sections.handoff.inbox[]")
    ],
    important_files: uniqueHandoffItems([
      ...handoffItems(recordsAtPath(input.sections.boot, ["task_relevant"]), "sections.boot.task_relevant[]"),
      ...handoffItems(recordsAtPath(input.sections.boot, ["skills"]), "sections.boot.skills[]")
    ]),
    risks: handoffItems(recordsAtPath(input.sections.boot, ["project", "warnings"]), "sections.boot.project.warnings[]"),
    user_preferences: handoffItems(recordsAtPath(input.sections.boot, ["profile", "user_preferences"]), "sections.boot.profile.user_preferences[]"),
    next_actions: Object.entries(input.next.actions_by_id)
      .map(([id, action]) => handoffNextAction(id, action))
      .filter((action): action is HandoffPackNextAction => action !== undefined),
    evidence: {
      boot: "sections.boot",
      refresh: "sections.refresh",
      handoff: "sections.handoff",
      next: "next"
    }
  };

  return {
    ...packWithoutQualityGate,
    quality_gate: buildHandoffQualityGate(packWithoutQualityGate),
    selection_sources: HANDOFF_PACK_SELECTION_SOURCES
  };
}

function buildHandoffQualityGate(pack: HandoffPackWithoutQualityGate): HandoffQualityGate {
  const checks: HandoffQualityGateCheck[] = [
    requiredValueCheck({
      id: "current_goal",
      label: "Current goal",
      source: "handoff_pack.current_goal",
      present: Boolean(pack.current_goal?.text.trim()),
      passMessage: "Current goal is present.",
      warnMessage: "Context pack has no current goal; pass --current-task when starting focused work."
    }),
    collectionEvidenceCheck({
      id: "recent_decisions",
      label: "Recent decisions",
      source: "handoff_pack.recent_decisions[]",
      items: pack.recent_decisions,
      emptyMessage: "No recent decisions are currently available.",
      passMessage: "Recent decisions include evidence paths."
    }),
    collectionEvidenceCheck({
      id: "open_threads",
      label: "Open threads",
      source: "handoff_pack.open_threads[]",
      items: pack.open_threads,
      emptyMessage: "No open handoff threads are currently available.",
      passMessage: "Open threads include evidence paths."
    }),
    collectionEvidenceCheck({
      id: "risks",
      label: "Risks",
      source: "handoff_pack.risks[]",
      items: pack.risks,
      emptyMessage: "No explicit risks are currently available.",
      passMessage: "Risks include evidence paths."
    }),
    requiredValueCheck({
      id: "evidence_paths",
      label: "Evidence paths",
      source: "handoff_pack.evidence",
      present: hasCompleteEvidenceMap(pack.evidence),
      passMessage: "Raw boot, refresh, handoff, and next evidence paths are present.",
      warnMessage: "Handoff pack is missing one or more raw evidence paths."
    }),
    requiredValueCheck({
      id: "capture_next_action",
      label: "Capture next action",
      source: "next.actions_by_id.capture_session",
      present: pack.next_actions.some((action) => action.id === "capture_session" && action.evidence.source === "next.actions_by_id.capture_session"),
      passMessage: "Required capture_session end action is present.",
      warnMessage: "Context pack is missing the required capture_session end action."
    })
  ];
  const failedCheckIds = checks
    .filter((check) => check.status === "warn")
    .map((check) => check.id);
  return {
    status: failedCheckIds.length > 0 ? "needs_review" : "ready",
    read_only: true,
    checks,
    checks_by_id: Object.fromEntries(checks.map((check) => [check.id, check])) as Record<HandoffQualityGateCheckId, HandoffQualityGateCheck>,
    failed_check_ids: failedCheckIds,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.message),
    selection_sources: HANDOFF_QUALITY_GATE_SELECTION_SOURCES
  };
}

function requiredValueCheck(input: {
  id: HandoffQualityGateCheckId;
  label: string;
  source: string;
  present: boolean;
  passMessage: string;
  warnMessage: string;
}): HandoffQualityGateCheck {
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    status: input.present ? "pass" : "warn",
    message: input.present ? input.passMessage : input.warnMessage
  };
}

function collectionEvidenceCheck(input: {
  id: HandoffQualityGateCheckId;
  label: string;
  source: string;
  items: HandoffPackItem[];
  emptyMessage: string;
  passMessage: string;
}): HandoffQualityGateCheck {
  const missingEvidence = input.items.some((item) => !item.evidence.source);
  const status = missingEvidence ? "warn" : "pass";
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    count: input.items.length,
    status,
    message: status === "warn"
      ? `${input.label} include entries without evidence paths.`
      : input.items.length > 0
        ? input.passMessage
        : input.emptyMessage
  };
}

function hasCompleteEvidenceMap(evidence: HandoffPackV2["evidence"]): boolean {
  return evidence.boot === "sections.boot"
    && evidence.refresh === "sections.refresh"
    && evidence.handoff === "sections.handoff"
    && evidence.next === "next";
}

function recordsAtPath(root: unknown, path: string[]): Array<Record<string, unknown>> {
  let value = root;
  for (const segment of path) {
    if (!value || typeof value !== "object") return [];
    value = (value as Record<string, unknown>)[segment];
  }
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function handoffItems(records: Array<Record<string, unknown>>, source: string): HandoffPackItem[] {
  return records
    .map((record) => {
      const text = handoffText(record);
      if (!text) return undefined;
      return {
        text,
        evidence: {
          source,
          ...(typeof record.record_id === "string" ? { record_id: record.record_id } : {}),
          ...(typeof record.id === "string" ? { record_id: record.id } : {})
        }
      };
    })
    .filter((item): item is HandoffPackItem => item !== undefined);
}

function handoffText(record: Record<string, unknown>): string | undefined {
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  const content = record.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
  return undefined;
}

function uniqueHandoffItems(items: HandoffPackItem[]): HandoffPackItem[] {
  const seen = new Set<string>();
  const unique: HandoffPackItem[] = [];
  for (const item of items) {
    const key = `${item.evidence.record_id ?? ""}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function handoffNextAction(id: string, action: unknown): HandoffPackNextAction | undefined {
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const candidate = action as Record<string, unknown>;
  return {
    id,
    ...(typeof candidate.command === "string" ? { command: candidate.command } : {}),
    ...(typeof candidate.required_when === "string" ? { required_when: candidate.required_when } : {}),
    evidence: {
      source: `next.actions_by_id.${id}`,
      ...(typeof candidate.command === "string" ? { command: candidate.command } : {})
    }
  };
}

function quoteCli(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
