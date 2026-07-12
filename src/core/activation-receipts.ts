import { createHash } from "node:crypto";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export type ActivationHost = "codex" | "claude";
export type ActivationReceiptEvent = "session_start" | "pre_compact" | "post_compact" | "stop" | "session_end";

export interface ActivationReceiptInput {
  activation_id: string;
  host: ActivationHost;
  project_id: string;
  event: ActivationReceiptEvent;
  session_id: string;
  device_id: string;
  occurred_at: string;
  command_digest: string;
}

export interface ActivationReceipt extends ActivationReceiptInput {
  version: 1;
}

function normalizedReceiptInput(input: ActivationReceiptInput): ActivationReceiptInput {
  if (input.event !== "stop") return input;
  const occurredAt = new Date(input.occurred_at);
  occurredAt.setUTCMinutes(0, 0, 0);
  return { ...input, occurred_at: occurredAt.toISOString() };
}

export function activationReceiptIdentity(input: ActivationReceiptInput): { digest: string; record_id: string; event_id: string } {
  const normalized = normalizedReceiptInput(input);
  const digest = createHash("sha256").update(JSON.stringify({
    activation_id: normalized.activation_id,
    host: normalized.host,
    project_id: normalized.project_id,
    event: normalized.event,
    session_id: normalized.session_id,
    device_id: normalized.device_id,
    occurred_at: normalized.occurred_at,
    command_digest: normalized.command_digest
  })).digest("hex");
  return { digest, record_id: `rec_activation_${digest.slice(0, 32)}`, event_id: `evt_activation_${digest.slice(0, 32)}` };
}

function hostLabel(host: ActivationHost): string {
  return host === "claude" ? "Claude" : "Codex";
}

export async function recordActivationReceipt(storePath: string, input: ActivationReceiptInput): Promise<{
  created: boolean;
  record: MorynRecord;
  receipt: ActivationReceipt;
}> {
  const normalized = normalizedReceiptInput(input);
  const identity = activationReceiptIdentity(normalized);
  const receipt: ActivationReceipt = { version: 1, ...normalized };
  const record: MorynRecord = {
    id: identity.record_id,
    kind: "agent_note",
    type: "activation_receipt",
    scope: "project",
    project_id: normalized.project_id,
    tags: ["activation", "activation-receipt", `host:${normalized.host}`, `event:${normalized.event}`],
    content: {
      format: "json",
      text: `${hostLabel(normalized.host)} activation receipt: ${normalized.event}`,
      activation_receipt_version: 1,
      activation_id: normalized.activation_id,
      host: normalized.host,
      event: normalized.event,
      session_id: normalized.session_id,
      device_id: normalized.device_id,
      command_digest: normalized.command_digest
    },
    state: "canonical",
    confidence: 1,
    priority: "low",
    visibility: "active",
    created_at: normalized.occurred_at,
    updated_at: normalized.occurred_at,
    source: { client: normalized.host, session_id: normalized.session_id, device_id: normalized.device_id },
    provenance: { method: "rule-promoted", reason: "Host lifecycle hook executed", promoted_at: normalized.occurred_at }
  };
  const event: MorynEvent = { event_id: identity.event_id, op: "upsert_record", record, created_at: normalized.occurred_at, source: record.source };
  const appended = await appendEventIfAbsent(storePath, event);
  return { created: appended.created, record, receipt };
}
