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

export function activationReceiptIdentity(input: ActivationReceiptInput): { digest: string; record_id: string; event_id: string } {
  const digest = createHash("sha256").update(JSON.stringify({
    activation_id: input.activation_id,
    host: input.host,
    project_id: input.project_id,
    event: input.event,
    session_id: input.session_id,
    device_id: input.device_id,
    occurred_at: input.occurred_at,
    command_digest: input.command_digest
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
  const identity = activationReceiptIdentity(input);
  const receipt: ActivationReceipt = { version: 1, ...input };
  const record: MorynRecord = {
    id: identity.record_id,
    kind: "agent_note",
    type: "activation_receipt",
    scope: "project",
    project_id: input.project_id,
    tags: ["activation", "activation-receipt", `host:${input.host}`, `event:${input.event}`],
    content: {
      format: "json",
      text: `${hostLabel(input.host)} activation receipt: ${input.event}`,
      activation_receipt_version: 1,
      activation_id: input.activation_id,
      host: input.host,
      event: input.event,
      session_id: input.session_id,
      device_id: input.device_id,
      command_digest: input.command_digest
    },
    state: "canonical",
    confidence: 1,
    priority: "low",
    visibility: "active",
    created_at: input.occurred_at,
    updated_at: input.occurred_at,
    source: { client: input.host, session_id: input.session_id, device_id: input.device_id },
    provenance: { method: "rule-promoted", reason: "Host lifecycle hook executed", promoted_at: input.occurred_at }
  };
  const event: MorynEvent = { event_id: identity.event_id, op: "upsert_record", record, created_at: input.occurred_at, source: record.source };
  const appended = await appendEventIfAbsent(storePath, event);
  return { created: appended.created, record, receipt };
}
