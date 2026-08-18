import { createHash } from "node:crypto";
import { getHostAdapter, type HostAdapterId, normalizeHostId } from "./host-adapter-registry.js";
import { getHostCapabilities, type HostLifecycleEvent } from "./host-capabilities.js";

export const AGENT_CONTINUITY_PROTOCOL_VERSION = "moryn.agent-continuity.v1" as const;

export const AGENT_CONTINUITY_OPERATIONS = [
  "enter",
  "start",
  "checkpoint",
  "finish",
  "handoff",
  "abort",
  "recover"
] as const;

export type AgentContinuityOperation = (typeof AGENT_CONTINUITY_OPERATIONS)[number];
export type AgentContinuityRouteMode = "native_hook" | "mcp" | "cli" | "unavailable";
export type AgentContinuityTransport = Exclude<AgentContinuityRouteMode, "unavailable">;

export interface AgentContinuityTransportAvailability {
  native_hook?: boolean;
  mcp?: boolean;
  cli?: boolean;
}

export interface AgentContinuityNegotiationInput {
  host: string;
  operations?: AgentContinuityOperation[];
  available_transports?: AgentContinuityTransportAvailability;
}

type OperationDefinition = {
  lifecycle_event: HostLifecycleEvent;
  mcp_tool: "agent_enter" | "agent_start" | "checkpoint" | "agent_finish" | "agent_status";
  cli_command: string;
};

const OPERATION_DEFINITIONS: Record<AgentContinuityOperation, OperationDefinition> = {
  enter: {
    lifecycle_event: "session_start",
    mcp_tool: "agent_enter",
    cli_command: "moryn agent enter --current-task <task>"
  },
  start: {
    lifecycle_event: "session_start",
    mcp_tool: "agent_start",
    cli_command: "moryn agent start --current-task <task>"
  },
  checkpoint: {
    lifecycle_event: "pre_compact",
    mcp_tool: "checkpoint",
    cli_command:
      "moryn agent checkpoint --agent <agent> --session-id <session_id> --device-id <device_id> --occurred-at <timestamp> --checkpoint-id <checkpoint_id> --progress <progress>"
  },
  finish: {
    lifecycle_event: "session_end",
    mcp_tool: "agent_finish",
    cli_command: "moryn agent finish --summary <summary>"
  },
  handoff: {
    lifecycle_event: "session_end",
    mcp_tool: "agent_finish",
    cli_command: "moryn agent finish --summary <handoff_summary>"
  },
  abort: {
    lifecycle_event: "stop",
    mcp_tool: "agent_status",
    cli_command: "moryn agent status --status <abort_reason>"
  },
  recover: {
    lifecycle_event: "post_compact",
    mcp_tool: "agent_start",
    cli_command: "moryn agent start --current-task <task>"
  }
};

const HOOK_EVENT_NAMES: Record<HostLifecycleEvent, string> = {
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  stop: "Stop",
  session_end: "SessionEnd"
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function hasMcpSupport(host: HostAdapterId): boolean {
  return getHostAdapter(host)?.supported_install_steps.includes("register_mcp") ?? false;
}

function transportSource(
  input: AgentContinuityTransportAvailability | undefined,
  transport: keyof AgentContinuityTransportAvailability
): "caller_declaration" | "adapter_registry" {
  return input?.[transport] === undefined ? "adapter_registry" : "caller_declaration";
}

function operationRoute(
  operation: AgentContinuityOperation,
  host: HostAdapterId,
  available: Required<AgentContinuityTransportAvailability>,
  availabilityInput: AgentContinuityTransportAvailability | undefined
) {
  const definition = OPERATION_DEFINITIONS[operation];
  const hostCapabilities = getHostCapabilities(host);
  if (available.native_hook && hostCapabilities.events[definition.lifecycle_event]) {
    return {
      mode: "native_hook" as const,
      lifecycle_event: definition.lifecycle_event,
      hook_event: HOOK_EVENT_NAMES[definition.lifecycle_event],
      capability_source: transportSource(availabilityInput, "native_hook")
    };
  }
  if (available.mcp && hasMcpSupport(host)) {
    return {
      mode: "mcp" as const,
      tool: definition.mcp_tool,
      capability_source: transportSource(availabilityInput, "mcp"),
      reason: hostCapabilities.events[definition.lifecycle_event]
        ? ("native_hook_not_available" as const)
        : ("native_hook_not_supported" as const)
    };
  }
  if (available.cli) {
    return {
      mode: "cli" as const,
      command: definition.cli_command,
      capability_source: transportSource(availabilityInput, "cli"),
      reason: hasMcpSupport(host) ? ("mcp_not_available" as const) : ("mcp_not_supported" as const)
    };
  }
  return {
    mode: "unavailable" as const,
    reason: "no_declared_transport" as const,
    capability_source: "caller_declaration" as const
  };
}

export function negotiateAgentContinuity(input: AgentContinuityNegotiationInput) {
  const host = normalizeHostId(input.host);
  const capabilities = getHostCapabilities(host);
  const requestedOperations = input.operations?.length
    ? [...new Set(input.operations)]
    : [...AGENT_CONTINUITY_OPERATIONS];
  const available = {
    native_hook: input.available_transports?.native_hook ?? capabilities.hook_transport !== "none",
    mcp: input.available_transports?.mcp ?? hasMcpSupport(host),
    cli: input.available_transports?.cli ?? true
  };
  const operationsByName = Object.fromEntries(
    requestedOperations.map((operation) => [
      operation,
      operationRoute(operation, host, available, input.available_transports)
    ])
  ) as Record<AgentContinuityOperation, ReturnType<typeof operationRoute>>;
  const descriptor = {
    protocol_version: AGENT_CONTINUITY_PROTOCOL_VERSION,
    host,
    hooks: {
      transport: capabilities.hook_transport,
      context_injection: capabilities.context_injection,
      events: capabilities.events
    },
    mcp: {
      supported: hasMcpSupport(host),
      registration: getHostAdapter(host)?.mcp_registration.command ?? null
    },
    cli: { supported: true },
    transcript_evidence: capabilities.hook_transport === "none" ? "none" : "hook_event_payload",
    workspace_identity: "project_config_or_caller_supplied",
    available_transports: available
  } as const;
  const receiptCore = {
    protocol_version: AGENT_CONTINUITY_PROTOCOL_VERSION,
    host,
    requested_operations: requestedOperations,
    routes: Object.fromEntries(
      Object.entries(operationsByName).map(([operation, route]) => [operation, { mode: route.mode }])
    )
  };
  const evidenceDigest = digest(receiptCore);

  return {
    protocol_version: AGENT_CONTINUITY_PROTOCOL_VERSION,
    host,
    descriptor,
    operations_by_name: operationsByName,
    conformance: {
      conformant: Object.values(operationsByName).every((route) => route.mode !== "unavailable"),
      unavailable_operations: requestedOperations.filter(
        (operation) => operationsByName[operation].mode === "unavailable"
      )
    },
    receipt: {
      receipt_id: `continuity_${evidenceDigest.slice(0, 32)}`,
      evidence_digest: evidenceDigest,
      content_included: false
    },
    selection_sources: {
      operation: "operations_by_name.<operation>",
      route: "operations_by_name.<operation>.mode",
      receipt: "receipt"
    }
  };
}

export interface AgentContinuityTransferInput {
  project_id: string;
  source_host: string;
  target_host: string;
  source_transports?: AgentContinuityTransportAvailability;
  target_transports?: AgentContinuityTransportAvailability;
}

export function buildAgentContinuityTransferPlan(input: AgentContinuityTransferInput) {
  const projectId = input.project_id.trim();
  if (!projectId) throw new Error("project_id is required");
  const source = negotiateAgentContinuity({
    host: input.source_host,
    operations: ["checkpoint", "handoff"],
    available_transports: input.source_transports
  });
  const target = negotiateAgentContinuity({
    host: input.target_host,
    operations: ["enter", "recover"],
    available_transports: input.target_transports
  });
  const workspaceIdentityDigest = digest({ project_id: projectId });
  const sequence = [
    {
      id: "source_checkpoint",
      host: source.host,
      operation: "checkpoint" as const,
      route: source.operations_by_name.checkpoint
    },
    {
      id: "source_handoff",
      host: source.host,
      operation: "handoff" as const,
      route: source.operations_by_name.handoff
    },
    { id: "target_enter", host: target.host, operation: "enter" as const, route: target.operations_by_name.enter },
    { id: "target_recover", host: target.host, operation: "recover" as const, route: target.operations_by_name.recover }
  ];
  const receiptCore = {
    protocol_version: AGENT_CONTINUITY_PROTOCOL_VERSION,
    workspace_identity_digest: workspaceIdentityDigest,
    source_host: source.host,
    target_host: target.host,
    sequence: sequence.map((step) => ({ id: step.id, operation: step.operation, mode: step.route.mode }))
  };
  const evidenceDigest = digest(receiptCore);

  return {
    protocol_version: AGENT_CONTINUITY_PROTOCOL_VERSION,
    workspace: { project_id: projectId, identity_digest: workspaceIdentityDigest },
    source: { host: source.host, receipt: source.receipt },
    target: { host: target.host, receipt: target.receipt },
    sequence,
    ready: sequence.every((step) => step.route.mode !== "unavailable"),
    receipt: {
      receipt_id: `continuity_transfer_${evidenceDigest.slice(0, 32)}`,
      evidence_digest: evidenceDigest,
      content_included: false
    },
    selection_sources: {
      next_step: "sequence.<first incomplete step>",
      route: "sequence.<step>.route",
      receipt: "receipt"
    }
  };
}
