import { describe, expect, it } from "vitest";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { listSoulDeliveryReceipts } from "../../src/core/soul-delivery-receipts.js";
import { buildSoulHostContext } from "../../src/core/soul-host-delivery.js";
import { compileEffectiveSoul, createSoulProfileRevision } from "../../src/core/soul-profile.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const occurredAt = "2026-07-20T06:00:00.000Z";

function activeProfile() {
  return createSoulProfileRevision({
    subject: { kind: "agent", subject_id: "moryn" },
    generation: 1,
    clauses: [
      {
        clause_key: "persona",
        category: "identity",
        text: "Act as a careful cross-host collaborator.",
        distribution: "personal_sync"
      }
    ],
    state: "active",
    approved: true,
    approval_receipt_id: "user-approved:soul-host-test",
    created_at: occurredAt
  });
}

async function persistActiveProfile(
  storePath: string,
  input: { text?: string; from_revision_id?: string; occurred_at?: string } = {}
) {
  const source = { client: "codex", device_id: "device-a" };
  const draftAt = input.occurred_at ?? occurredAt;
  const draft = await createSoulProfileDraft(storePath, {
    ...(input.from_revision_id
      ? { from_revision_id: input.from_revision_id }
      : { subject: { kind: "agent" as const, subject_id: "moryn" } }),
    clauses: [
      {
        clause_key: "persona",
        category: "identity",
        text: input.text ?? "Act as a careful cross-host collaborator.",
        distribution: "personal_sync"
      }
    ],
    source,
    occurred_at: draftAt
  });
  return (
    await approveSoulProfileDraft(storePath, {
      revision_id: draft.revision.revision_id,
      confirmed: true,
      source,
      occurred_at: new Date(Date.parse(draftAt) + 1_000).toISOString()
    })
  ).revision;
}

describe("Soul Host delivery", () => {
  it("withholds a blocked Soul Pack instead of injecting mandatory text over budget", () => {
    const profile = activeProfile();
    const effective = compileEffectiveSoul({ revisions: [profile], char_budget: 20 });
    const context = buildSoulHostContext(effective);

    expect(context).toMatchObject({
      status: "blocked",
      deliverable: false,
      host_context_prepared: false
    });
    expect(context).not.toHaveProperty("rendered");
    expect(JSON.stringify(context)).not.toContain("Act as a careful cross-host collaborator.");
  });

  it("injects and receipts the same approved revision on SessionStart after compaction", async () => {
    await withInitializedTempStore(async (storePath) => {
      const profile = await persistActiveProfile(storePath);
      const base = {
        host: "codex" as const,
        session_id: "session-a",
        device_id: "device-a",
        cwd: "/workspace/Moryn",
        occurred_at: occurredAt
      };

      const started = await runHostHook({
        storePath,
        hook: { ...base, event: "session_start" },
        project_id: "moryn",
        pull: false
      });
      expect(started.soul_delivery?.context).toMatchObject({
        status: "ready",
        deliverable: true,
        host_context_prepared: true,
        source_revision_ids: [profile.revision_id],
        proof_scope: "hook_output_prepared_not_host_acknowledged_or_obedience"
      });
      expect(started.hook_output.additional_context).toContain("Act as a careful cross-host collaborator.");
      expect(started.hook_output.additional_context).not.toContain('"clauses"');

      const compacted = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact", occurred_at: "2026-07-20T06:05:00.000Z" },
        project_id: "moryn",
        pull: false
      });
      expect(compacted).toMatchObject({ action: "defer_to_session_start", hook_output: { additional_context: "" } });
      expect(compacted.soul_delivery).toBeUndefined();
      const resumed = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "session_start",
          trigger: "compact",
          occurred_at: "2026-07-20T06:06:00.000Z"
        },
        project_id: "moryn",
        pull: false
      });
      expect(resumed.soul_delivery?.context).toMatchObject({ host_context_prepared: true });
      const receipts = await listSoulDeliveryReceipts(storePath);
      expect(receipts).toHaveLength(2);
      expect(receipts.map((receipt) => receipt.event)).toEqual(["session_start", "session_start"]);
      expect(new Set(receipts.map((receipt) => receipt.rendered_digest))).toHaveLength(1);
    });
  });

  it("reports not configured and writes no delivery proof when no approved profile exists", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({
        storePath,
        hook: {
          host: "claude",
          event: "session_start",
          session_id: "session-a",
          device_id: "device-a",
          cwd: "/workspace/Moryn",
          occurred_at: occurredAt
        },
        project_id: "moryn",
        pull: false
      });
      expect(result.soul_delivery?.context).toMatchObject({
        status: "not_configured",
        deliverable: false,
        host_context_prepared: false
      });
      expect(await listSoulDeliveryReceipts(storePath)).toEqual([]);
    });
  });

  it("defers a changed Soul until the compact SessionStart instead of injecting an implicit prompt delta", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await persistActiveProfile(storePath);
      const base = {
        host: "codex" as const,
        session_id: "session-a",
        device_id: "device-a",
        cwd: "/workspace/Moryn"
      };
      await runHostHook({
        storePath,
        hook: { ...base, event: "session_start", occurred_at: occurredAt },
        project_id: "moryn",
        pull: false
      });

      const unchanged = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "user_prompt_submit",
          prompt: "Continue the task",
          occurred_at: "2026-07-20T06:01:00.000Z"
        },
        project_id: "moryn"
      });
      expect(unchanged).not.toHaveProperty("soul_delivery");
      expect(unchanged.hook_output.additional_context).not.toContain("Moryn Soul delta");

      const second = await persistActiveProfile(storePath, {
        from_revision_id: first.revision_id,
        text: "Act as the updated cross-host release partner.",
        occurred_at: "2026-07-20T06:02:00.000Z"
      });

      const changed = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "user_prompt_submit",
          prompt: "Continue the task",
          occurred_at: "2026-07-20T06:03:00.000Z"
        },
        project_id: "moryn"
      });
      expect(changed).not.toHaveProperty("soul_delivery");
      expect(changed.hook_output.additional_context).not.toContain("Moryn Soul delta");
      expect(changed.hook_output.additional_context).not.toContain("Act as the updated cross-host release partner.");
      expect(await listSoulDeliveryReceipts(storePath)).toHaveLength(1);

      const compacted = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "post_compact",
          occurred_at: "2026-07-20T06:04:00.000Z"
        },
        project_id: "moryn",
        pull: false
      });
      expect(compacted).toMatchObject({ action: "defer_to_session_start" });
      const resumed = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "session_start",
          trigger: "compact",
          occurred_at: "2026-07-20T06:05:00.000Z"
        },
        project_id: "moryn",
        pull: false
      });
      expect(resumed.soul_delivery).toMatchObject({
        delivery: "prepared",
        context: {
          host_context_prepared: true,
          source_revision_ids: [second.revision_id]
        }
      });
      expect(resumed.hook_output.additional_context).toContain("Act as the updated cross-host release partner.");
      expect(await listSoulDeliveryReceipts(storePath)).toHaveLength(2);
    });
  });
});
