import { createHash } from "node:crypto";
import type { HostAdapterId } from "./host-adapter-registry.js";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export type HostHookExecutionStatus = "timed_out" | "cancelled";
export type HostHookExecutionStage =
  | "resolve_project"
  | "activation_receipt"
  | "recall"
  | "start"
  | "checkpoint"
  | "checkpoint_sync"
  | "synthesis"
  | "finish"
  | "status"
  | "status_sync";

export interface HostHookExecutionReceiptInput {
  host: HostAdapterId;
  event: "session_start" | "user_prompt_submit" | "pre_compact" | "post_compact" | "stop" | "session_end";
  project_id: string;
  session_id: string;
  device_id: string;
  occurred_at: string;
  status: HostHookExecutionStatus;
  stage: HostHookExecutionStage;
  activation_id?: string;
  command_digest?: string;
}

export interface HostHookExecutionReceipt extends HostHookExecutionReceiptInput {
  version: 1;
  recorded_at: string;
}

export function hostHookExecutionReceiptIdentity(input: HostHookExecutionReceiptInput): {
  record_id: string;
  event_id: string;
} {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        host: input.host,
        event: input.event,
        project_id: input.project_id,
        session_id: input.session_id,
        device_id: input.device_id,
        occurred_at: input.occurred_at,
        status: input.status,
        stage: input.stage,
        activation_id: input.activation_id,
        command_digest: input.command_digest
      })
    )
    .digest("hex");
  return {
    record_id: `rec_hook_execution_${digest.slice(0, 32)}`,
    event_id: `evt_hook_execution_${digest.slice(0, 32)}`
  };
}

export async function recordHostHookExecutionReceipt(
  storePath: string,
  input: HostHookExecutionReceiptInput
): Promise<{ created: boolean; record: MorynRecord; receipt: HostHookExecutionReceipt }> {
  const identity = hostHookExecutionReceiptIdentity(input);
  const recordedAt = new Date().toISOString();
  const receipt: HostHookExecutionReceipt = { version: 1, ...input, recorded_at: recordedAt };
  const record: MorynRecord = {
    id: identity.record_id,
    kind: "agent_note",
    type: "host_hook_execution_receipt",
    scope: "project",
    project_id: input.project_id,
    tags: ["host-hook", "execution-receipt", `host:${input.host}`, `event:${input.event}`, `status:${input.status}`],
    content: {
      format: "json",
      text: `${input.host} ${input.event} ${input.status} during ${input.stage}`,
      host_hook_execution_receipt_version: 1,
      host: input.host,
      event: input.event,
      status: input.status,
      stage: input.stage,
      session_id: input.session_id,
      device_id: input.device_id,
      occurred_at: input.occurred_at,
      recorded_at: recordedAt,
      ...(input.activation_id ? { activation_id: input.activation_id } : {}),
      ...(input.command_digest ? { command_digest: input.command_digest } : {})
    },
    state: "canonical",
    confidence: 1,
    priority: "normal",
    visibility: "active",
    created_at: recordedAt,
    updated_at: recordedAt,
    source: { client: input.host, session_id: input.session_id, device_id: input.device_id },
    provenance: { method: "rule-promoted", reason: "Host lifecycle operation did not complete in budget" }
  };
  const event: MorynEvent = {
    event_id: identity.event_id,
    op: "upsert_record",
    record,
    created_at: recordedAt,
    source: record.source
  };
  const appended = await appendEventIfAbsent(storePath, event);
  if (appended.event.op !== "upsert_record") {
    throw new Error(`Host hook execution receipt collision: ${identity.event_id}`);
  }
  const persistedReceipt: HostHookExecutionReceipt = {
    ...receipt,
    recorded_at:
      typeof appended.event.record.content.recorded_at === "string"
        ? appended.event.record.content.recorded_at
        : receipt.recorded_at
  };
  return { created: appended.created, record: appended.event.record, receipt: persistedReceipt };
}
