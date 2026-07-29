import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ActivationHost, ActivationReceiptEvent } from "./activation-receipts.js";
import { shellQuote } from "./cli-command-line.js";
import {
  buildHostIntegrationArtifact,
  type HostIntegrationArtifact,
  type HostRuntimeDescriptor,
  isMorynHookOwnedByArtifact
} from "./host-integration-artifacts.js";
import { projectFileExists, resolveProjectWriteTarget } from "./project-write-boundary.js";
import { readCurrentRecords } from "./record-read-model.js";

export type ActivationStatus =
  | "active"
  | "configured_unverified"
  | "generated_not_activated"
  | "stale_moryn_config"
  | "invalid_config"
  | "blocked_by_policy"
  | "host_schema_unknown"
  | "not_installed";

export type RuntimeBindingStatus = "not_required" | "current" | "missing" | "stale" | "unavailable";

export interface ActivationSuggestedAction {
  id:
    | "activate_claude_hooks"
    | "repair_claude_hooks"
    | "inspect_invalid_claude_config"
    | "activate_codex_hooks"
    | "repair_codex_hooks"
    | "inspect_invalid_codex_config"
    | "trust_codex_hooks"
    | "generate_host_fragment";
  title: string;
  safe_to_run: boolean;
  command: string;
}

export interface HostActivationStatus {
  status: ActivationStatus;
  healthy: boolean;
  host: ActivationHost;
  activation_id: string;
  fragment_path: string;
  target_path: string;
  expected_events: string[];
  configured_events: string[];
  observed_events: ActivationReceiptEvent[];
  owned_entries: number;
  stale_entries: number;
  runtime_binding_status: RuntimeBindingStatus;
  runtime_binding_path?: string;
  runtime_binding_unavailable_marker?: string;
  runtime_binding_error?: string;
  repairable_automatically: boolean;
  last_receipt?: {
    record_id: string;
    event: ActivationReceiptEvent;
    occurred_at: string;
    session_id?: string;
    device_id?: string;
  };
  suggested_actions: ActivationSuggestedAction[];
}

function ownedCommandsFromEntry(entry: unknown, artifact: HostIntegrationArtifact): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks.flatMap((item) => {
    const command =
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "command" &&
      typeof (item as Record<string, unknown>).command === "string"
        ? ((item as Record<string, unknown>).command as string)
        : undefined;
    return isMorynHookOwnedByArtifact(command, artifact) ? [command!] : [];
  });
}

function activationActions(input: {
  status: ActivationStatus;
  host: ActivationHost;
  project_path: string;
}): ActivationSuggestedAction[] {
  if (input.status === "active") return [];
  if (input.host === "codex") {
    if (input.status === "configured_unverified")
      return [
        {
          id: "trust_codex_hooks",
          title: "Review and trust project hooks in Codex",
          safe_to_run: false,
          command: "/hooks"
        }
      ];
    if (input.status === "invalid_config")
      return [
        {
          id: "inspect_invalid_codex_config",
          title: "Inspect invalid Codex hooks before repair",
          safe_to_run: false,
          command: `cat ${shellQuote(join(input.project_path, ".codex", "hooks.json"))}`
        }
      ];
    return [
      {
        id:
          input.status === "stale_moryn_config"
            ? "repair_codex_hooks"
            : input.status === "not_installed"
              ? "generate_host_fragment"
              : "activate_codex_hooks",
        title: input.status === "stale_moryn_config" ? "Repair Moryn-owned Codex hooks" : "Activate Codex hooks",
        safe_to_run: true,
        command: `moryn activation apply --host codex --project ${shellQuote(input.project_path)}`
      }
    ];
  }
  if (input.status === "configured_unverified") return [];
  if (input.status === "invalid_config")
    return [
      {
        id: "inspect_invalid_claude_config",
        title: "Inspect invalid Claude settings before repair",
        safe_to_run: false,
        command: `cat ${shellQuote(join(input.project_path, ".claude", "settings.local.json"))}`
      }
    ];
  return [
    {
      id: input.status === "stale_moryn_config" ? "repair_claude_hooks" : "activate_claude_hooks",
      title: input.status === "stale_moryn_config" ? "Repair Moryn-owned Claude hooks" : "Activate Claude hooks",
      safe_to_run: true,
      command: `moryn activation apply --host claude --project ${shellQuote(input.project_path)}`
    }
  ];
}

export async function inspectHostActivation(input: {
  store_path: string;
  project_path: string;
  project_id: string;
  host: string;
  now?: string;
  runtime?: HostRuntimeDescriptor;
}): Promise<HostActivationStatus> {
  const artifact = buildHostIntegrationArtifact({
    host: input.host,
    project_id: input.project_id,
    project_path: input.project_path,
    store_path: input.store_path,
    runtime: input.runtime
  });
  const fragmentBoundary = await resolveProjectWriteTarget(
    input.project_path,
    artifact.path,
    `${artifact.host} integration`
  );
  const targetBoundary = await resolveProjectWriteTarget(
    input.project_path,
    artifact.merge_target,
    `${artifact.host} activation`
  );
  const fragmentPath = fragmentBoundary.target_path;
  const targetPath = targetBoundary.target_path;
  const fragmentExists = await projectFileExists(fragmentBoundary, `${artifact.host} integration`);
  let runtimeBindingStatus: RuntimeBindingStatus = "not_required";
  let runtimeBindingError: string | undefined;
  if (artifact.runtime_binding) {
    try {
      const runtimeBindingBoundary = await resolveProjectWriteTarget(
        artifact.runtime_binding.root_path,
        artifact.runtime_binding.relative_path,
        `${artifact.host} runtime binding`
      );
      const runtimeUnavailableBoundary = await resolveProjectWriteTarget(
        artifact.runtime_binding.root_path,
        `${artifact.runtime_binding.relative_path}.unavailable`,
        `${artifact.host} runtime unavailable marker`
      );
      const runtimeUnavailable = await projectFileExists(
        runtimeUnavailableBoundary,
        `${artifact.host} runtime unavailable marker`
      );
      const runtimeBindingExists = await projectFileExists(runtimeBindingBoundary, `${artifact.host} runtime binding`);
      if (runtimeUnavailable) {
        runtimeBindingStatus = "unavailable";
      } else if (!runtimeBindingExists) {
        runtimeBindingStatus = "missing";
      } else {
        const runtimeBindingMode = (await stat(runtimeBindingBoundary.target_path)).mode & 0o777;
        runtimeBindingStatus =
          runtimeBindingMode === 0o700 &&
          (await readFile(runtimeBindingBoundary.target_path, "utf8")) === artifact.runtime_binding.content
            ? "current"
            : "stale";
      }
    } catch (error) {
      runtimeBindingStatus = "unavailable";
      runtimeBindingError = error instanceof Error ? error.message : String(error);
    }
  }
  const runtimeBindingEvidence = artifact.runtime_binding
    ? {
        runtime_binding_status: runtimeBindingStatus,
        runtime_binding_path: artifact.runtime_binding.path,
        runtime_binding_unavailable_marker: artifact.runtime_binding.unavailable_marker_path,
        ...(runtimeBindingError ? { runtime_binding_error: runtimeBindingError } : {})
      }
    : { runtime_binding_status: runtimeBindingStatus };
  const records = (await readCurrentRecords(input.store_path)).records
    .filter(
      (record) =>
        record.type === "activation_receipt" &&
        record.project_id === input.project_id &&
        record.content.activation_id === artifact.activation_id &&
        record.content.command_digest === artifact.command_digest
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id));
  const observedEvents = [
    ...new Set(
      records
        .map((record) => record.content.event)
        .filter((event): event is ActivationReceiptEvent => typeof event === "string")
    )
  ];
  const lastRecord = records[0];
  const now = Date.parse(input.now ?? new Date().toISOString());
  const receiptFresh = lastRecord ? now - Date.parse(lastRecord.created_at) <= 24 * 60 * 60 * 1000 : false;
  const lastReceipt = lastRecord
    ? {
        record_id: lastRecord.id,
        event: lastRecord.content.event as ActivationReceiptEvent,
        occurred_at: lastRecord.created_at,
        session_id: lastRecord.source.session_id,
        device_id: lastRecord.source.device_id
      }
    : undefined;

  let settings: Record<string, unknown> | undefined;
  if (await projectFileExists(targetBoundary, `${artifact.host} activation`)) {
    try {
      const parsed = JSON.parse(await readFile(targetPath, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        ("hooks" in parsed &&
          (!(parsed as Record<string, unknown>).hooks ||
            typeof (parsed as Record<string, unknown>).hooks !== "object" ||
            Array.isArray((parsed as Record<string, unknown>).hooks)))
      )
        throw new Error("shape");
      settings = parsed as Record<string, unknown>;
    } catch {
      const status: ActivationStatus = "invalid_config";
      return {
        status,
        healthy: false,
        host: artifact.host,
        activation_id: artifact.activation_id,
        fragment_path: fragmentPath,
        target_path: targetPath,
        expected_events: artifact.expected_events,
        configured_events: [],
        observed_events: observedEvents,
        owned_entries: 0,
        stale_entries: 0,
        ...runtimeBindingEvidence,
        repairable_automatically: false,
        ...(lastReceipt ? { last_receipt: lastReceipt } : {}),
        suggested_actions: activationActions({ status, host: artifact.host, project_path: input.project_path })
      };
    }
  }

  let ownedEntries = 0;
  let staleEntries = 0;
  const configuredEvents: string[] = [];
  const hooks = settings?.hooks as Record<string, unknown> | undefined;
  const generatedHooks = (JSON.parse(artifact.content) as { hooks: Record<string, unknown> }).hooks;
  if (hooks) {
    for (const event of artifact.expected_events) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const expectedEntries = generatedHooks[event];
      const expectedEntry = Array.isArray(expectedEntries) ? expectedEntries[0] : undefined;
      let currentEntries = 0;
      for (const entry of entries) {
        const commands = ownedCommandsFromEntry(entry, artifact);
        if (commands.length === 0) continue;
        ownedEntries += 1;
        if (expectedEntry !== undefined && JSON.stringify(entry) === JSON.stringify(expectedEntry)) currentEntries += 1;
        else staleEntries += 1;
      }
      if (currentEntries > 0) configuredEvents.push(event);
      if (currentEntries > 1) staleEntries += currentEntries - 1;
    }
    const expectedEvents = new Set(artifact.expected_events);
    for (const [event, entries] of Object.entries(hooks)) {
      if (expectedEvents.has(event) || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (ownedCommandsFromEntry(entry, artifact).length === 0) continue;
        ownedEntries += 1;
        staleEntries += 1;
      }
    }
  }
  const runtimeBindingCurrent = runtimeBindingStatus === "not_required" || runtimeBindingStatus === "current";
  const fullyConfigured =
    configuredEvents.length === artifact.expected_events.length && staleEntries === 0 && runtimeBindingCurrent;
  const status: ActivationStatus =
    receiptFresh && fullyConfigured
      ? "active"
      : staleEntries > 0 || (ownedEntries > 0 && !fullyConfigured)
        ? "stale_moryn_config"
        : fullyConfigured
          ? "configured_unverified"
          : fragmentExists
            ? "generated_not_activated"
            : "not_installed";
  return {
    status,
    healthy: status === "active" || status === "configured_unverified",
    host: artifact.host,
    activation_id: artifact.activation_id,
    fragment_path: fragmentPath,
    target_path: targetPath,
    expected_events: artifact.expected_events,
    configured_events: configuredEvents,
    observed_events: observedEvents,
    owned_entries: ownedEntries,
    stale_entries: staleEntries,
    ...runtimeBindingEvidence,
    repairable_automatically:
      status === "not_installed" || status === "generated_not_activated" || status === "stale_moryn_config",
    ...(lastReceipt ? { last_receipt: lastReceipt } : {}),
    suggested_actions: activationActions({ status, host: artifact.host, project_path: input.project_path })
  };
}
