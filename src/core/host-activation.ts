import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHostIntegrationArtifact } from "./host-integration-artifacts.js";
import { readEvents } from "./store.js";
import { replayEvents } from "./replay.js";
import type { ActivationHost, ActivationReceiptEvent } from "./activation-receipts.js";

export type ActivationStatus = "active" | "configured_unverified" | "generated_not_activated" | "stale_moryn_config" | "invalid_config" | "blocked_by_policy" | "host_schema_unknown" | "not_installed";

export interface ActivationSuggestedAction {
  id: "activate_claude_hooks" | "repair_claude_hooks" | "inspect_invalid_claude_config" | "merge_codex_fragment" | "generate_host_fragment";
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
  repairable_automatically: boolean;
  last_receipt?: { record_id: string; event: ActivationReceiptEvent; occurred_at: string; session_id?: string; device_id?: string };
  suggested_actions: ActivationSuggestedAction[];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function commandFromEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return undefined;
  const hook = hooks.find((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).command === "string") as Record<string, unknown> | undefined;
  return typeof hook?.command === "string" ? hook.command : undefined;
}

function activationActions(input: { status: ActivationStatus; host: ActivationHost; project_path: string }): ActivationSuggestedAction[] {
  if (input.status === "active" || input.status === "configured_unverified") return [];
  if (input.host === "codex") return [{ id: input.status === "not_installed" ? "generate_host_fragment" : "merge_codex_fragment", title: input.status === "not_installed" ? "Generate Codex hook fragment" : "Merge Codex hook fragment using the installed host schema", safe_to_run: input.status === "not_installed", command: `moryn install --host codex --project '${input.project_path}' --apply` }];
  if (input.status === "invalid_config") return [{ id: "inspect_invalid_claude_config", title: "Inspect invalid Claude settings before repair", safe_to_run: false, command: `cat '${join(input.project_path, ".claude", "settings.local.json")}'` }];
  return [{ id: input.status === "stale_moryn_config" ? "repair_claude_hooks" : "activate_claude_hooks", title: input.status === "stale_moryn_config" ? "Repair Moryn-owned Claude hooks" : "Activate Claude hooks", safe_to_run: true, command: `moryn activation apply --host claude --project '${input.project_path}'` }];
}

export async function inspectHostActivation(input: { store_path: string; project_path: string; project_id: string; host: string; now?: string }): Promise<HostActivationStatus> {
  const artifact = buildHostIntegrationArtifact({ host: input.host, project_id: input.project_id, project_path: input.project_path, store_path: input.store_path });
  const fragmentPath = join(input.project_path, artifact.path);
  const targetPath = join(input.project_path, artifact.merge_target);
  const fragmentExists = await exists(fragmentPath);
  const records = [...replayEvents(await readEvents(input.store_path)).values()]
    .filter((record) => record.type === "activation_receipt" && record.project_id === input.project_id && record.content.activation_id === artifact.activation_id)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id));
  const observedEvents = [...new Set(records.map((record) => record.content.event).filter((event): event is ActivationReceiptEvent => typeof event === "string"))];
  const lastRecord = records[0];
  const now = Date.parse(input.now ?? new Date().toISOString());
  const receiptFresh = lastRecord ? now - Date.parse(lastRecord.created_at) <= 24 * 60 * 60 * 1000 : false;
  const lastReceipt = lastRecord ? { record_id: lastRecord.id, event: lastRecord.content.event as ActivationReceiptEvent, occurred_at: lastRecord.created_at, session_id: lastRecord.source.session_id, device_id: lastRecord.source.device_id } : undefined;

  if (artifact.host === "codex") {
    const status: ActivationStatus = receiptFresh ? "active" : fragmentExists ? "host_schema_unknown" : "not_installed";
    return { status, healthy: status === "active", host: "codex", activation_id: artifact.activation_id, fragment_path: fragmentPath, target_path: targetPath, expected_events: artifact.expected_events, configured_events: [], observed_events: observedEvents, owned_entries: 0, stale_entries: 0, repairable_automatically: status === "not_installed", ...(lastReceipt ? { last_receipt: lastReceipt } : {}), suggested_actions: activationActions({ status, host: "codex", project_path: input.project_path }) };
  }

  let settings: Record<string, unknown> | undefined;
  if (await exists(targetPath)) {
    try {
      const parsed = JSON.parse(await readFile(targetPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || ("hooks" in parsed && (!(parsed as Record<string, unknown>).hooks || typeof (parsed as Record<string, unknown>).hooks !== "object" || Array.isArray((parsed as Record<string, unknown>).hooks)))) throw new Error("shape");
      settings = parsed as Record<string, unknown>;
    } catch {
      const status: ActivationStatus = "invalid_config";
      return { status, healthy: false, host: "claude", activation_id: artifact.activation_id, fragment_path: fragmentPath, target_path: targetPath, expected_events: artifact.expected_events, configured_events: [], observed_events: observedEvents, owned_entries: 0, stale_entries: 0, repairable_automatically: false, ...(lastReceipt ? { last_receipt: lastReceipt } : {}), suggested_actions: activationActions({ status, host: "claude", project_path: input.project_path }) };
    }
  }

  let ownedEntries = 0;
  let staleEntries = 0;
  const configuredEvents: string[] = [];
  const hooks = settings?.hooks as Record<string, unknown> | undefined;
  if (hooks) {
    for (const event of artifact.expected_events) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      let current = false;
      for (const entry of entries) {
        const command = commandFromEntry(entry);
        if (!command || !command.split(/\s+/).includes(artifact.activation_id)) continue;
        ownedEntries += 1;
        if (command === artifact.command) current = true;
        else staleEntries += 1;
      }
      if (current) configuredEvents.push(event);
    }
  }
  const fullyConfigured = configuredEvents.length === artifact.expected_events.length && staleEntries === 0;
  const status: ActivationStatus = receiptFresh && fullyConfigured
    ? "active"
    : staleEntries > 0 || (ownedEntries > 0 && !fullyConfigured)
      ? "stale_moryn_config"
      : fullyConfigured
        ? "configured_unverified"
        : fragmentExists
          ? "generated_not_activated"
          : "not_installed";
  return { status, healthy: status === "active" || status === "configured_unverified", host: "claude", activation_id: artifact.activation_id, fragment_path: fragmentPath, target_path: targetPath, expected_events: artifact.expected_events, configured_events: configuredEvents, observed_events: observedEvents, owned_entries: ownedEntries, stale_entries: staleEntries, repairable_automatically: status === "not_installed" || status === "generated_not_activated" || status === "stale_moryn_config", ...(lastReceipt ? { last_receipt: lastReceipt } : {}), suggested_actions: activationActions({ status, host: "claude", project_path: input.project_path }) };
}
