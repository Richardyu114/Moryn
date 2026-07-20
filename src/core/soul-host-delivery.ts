import type { HostAdapterId } from "./host-adapter-registry.js";
import { type SoulCompilationReceipt, writeSoulCompilationReceipt } from "./soul-compilation-receipts.js";
import {
  type SoulDeliveryEvent,
  type SoulDeliveryReceipt,
  writeSoulDeliveryReceipt
} from "./soul-delivery-receipts.js";
import type { EffectiveSoul } from "./soul-profile.js";

export interface SoulHostContext {
  version: 1;
  status: "not_configured" | "blocked" | "ready" | "ready_with_omissions";
  deliverable: boolean;
  host_context_prepared: boolean;
  source_revision_ids: string[];
  source_digest: string;
  rendered_digest: string;
  token_count: number;
  rendered?: string;
  omissions: EffectiveSoul["omissions"];
  conflicts: EffectiveSoul["conflicts"];
  delivery_receipt_ids: string[];
  proof_scope: "hook_output_prepared_not_host_acknowledged_or_obedience";
}

export interface DeliverEffectiveSoulInput {
  store_path: string;
  effective_soul: EffectiveSoul;
  host: HostAdapterId;
  project_id: string;
  session_id: string;
  device_id: string;
  event: SoulDeliveryEvent;
  occurred_at: string;
}

export interface DeliverEffectiveSoulResult {
  context: SoulHostContext;
  receipts: SoulDeliveryReceipt[];
  delivery: "prepared" | "not_deliverable" | "unsupported" | "receipt_failed";
  compilation_receipt?: SoulCompilationReceipt;
  warnings: Array<{
    code: "SOUL_COMPILATION_RECEIPT_FAILED" | "SOUL_DELIVERY_RECEIPT_FAILED" | "SOUL_HOST_UNSUPPORTED";
    reason: string;
  }>;
}

function baseContext(effectiveSoul: EffectiveSoul): Omit<SoulHostContext, "status" | "host_context_prepared"> {
  return {
    version: 1,
    deliverable: effectiveSoul.deliverable,
    source_revision_ids: effectiveSoul.selected_revisions.map((revision) => revision.revision_id),
    source_digest: effectiveSoul.source_digest,
    rendered_digest: effectiveSoul.rendered_digest,
    token_count: effectiveSoul.budget.tokens_used,
    omissions: effectiveSoul.omissions,
    conflicts: effectiveSoul.conflicts,
    delivery_receipt_ids: [],
    proof_scope: "hook_output_prepared_not_host_acknowledged_or_obedience"
  };
}

export function buildSoulHostContext(effectiveSoul: EffectiveSoul): SoulHostContext {
  const base = baseContext(effectiveSoul);
  if (effectiveSoul.selected_revisions.length === 0) {
    return { ...base, status: "not_configured", deliverable: false, host_context_prepared: false };
  }
  if (!effectiveSoul.deliverable) {
    return { ...base, status: "blocked", host_context_prepared: false };
  }
  return {
    ...base,
    status: effectiveSoul.status,
    host_context_prepared: false,
    rendered: effectiveSoul.rendered
  };
}

export async function deliverEffectiveSoul(input: DeliverEffectiveSoulInput): Promise<DeliverEffectiveSoulResult> {
  const context = buildSoulHostContext(input.effective_soul);
  let compilationReceipt: SoulCompilationReceipt | undefined;
  const warnings: DeliverEffectiveSoulResult["warnings"] = [];
  try {
    compilationReceipt = (await writeSoulCompilationReceipt(input.store_path, input.effective_soul, input.occurred_at))
      .receipt;
  } catch (error) {
    warnings.push({
      code: "SOUL_COMPILATION_RECEIPT_FAILED",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  const compilation = compilationReceipt ? { compilation_receipt: compilationReceipt } : {};
  if (!context.deliverable || !context.rendered) {
    return { context, receipts: [], delivery: "not_deliverable", ...compilation, warnings };
  }
  if (input.host !== "codex" && input.host !== "claude") {
    warnings.push({
      code: "SOUL_HOST_UNSUPPORTED",
      reason: `Soul delivery receipts are not supported for host ${input.host}`
    });
    return {
      context,
      receipts: [],
      delivery: "unsupported",
      ...compilation,
      warnings
    };
  }

  try {
    const receipts: SoulDeliveryReceipt[] = [];
    for (const revision of input.effective_soul.selected_revisions) {
      const written = await writeSoulDeliveryReceipt(input.store_path, {
        profile_id: revision.profile_id,
        source_revision_ids: [revision.revision_id],
        source_digest: input.effective_soul.source_digest,
        rendered_digest: input.effective_soul.rendered_digest,
        host: input.host,
        project_id: input.project_id,
        session_id: input.session_id,
        device_id: input.device_id,
        event: input.event,
        occurred_at: input.occurred_at
      });
      receipts.push(written.receipt);
    }
    return {
      context: {
        ...context,
        host_context_prepared: true,
        delivery_receipt_ids: receipts.map((receipt) => receipt.receipt_id)
      },
      receipts,
      delivery: "prepared",
      ...compilation,
      warnings
    };
  } catch (error) {
    warnings.push({
      code: "SOUL_DELIVERY_RECEIPT_FAILED",
      reason: error instanceof Error ? error.message : String(error)
    });
    return {
      context,
      receipts: [],
      delivery: "receipt_failed",
      ...compilation,
      warnings
    };
  }
}
