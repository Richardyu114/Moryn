import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { compileEffectiveSoul, type SoulClauseInput } from "../../src/core/soul-profile.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { readSoulProfileRevisions } from "../../src/core/soul-profile-store.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);
const projectId = "portable-soul-e2e";

const clause = (clauseKey: string, text: string): SoulClauseInput => ({
  clause_key: clauseKey,
  category: "collaboration",
  text,
  distribution: "personal_sync",
  priority: 80
});

async function createApprovedProfile(
  storePath: string,
  input: {
    subject: { kind: "user" | "agent"; subject_id: string };
    clause: SoulClauseInput;
    deviceId: string;
    draftAt: string;
    approvedAt: string;
  }
) {
  const source = { client: "user", device_id: input.deviceId };
  const draft = await createSoulProfileDraft(storePath, {
    subject: input.subject,
    clauses: [input.clause],
    source,
    occurred_at: input.draftAt
  });
  return approveSoulProfileDraft(storePath, {
    revision_id: draft.revision.revision_id,
    confirmed: true,
    source,
    occurred_at: input.approvedAt
  });
}

async function createApprovedBranch(
  storePath: string,
  input: {
    parentRevisionId: string;
    clause: SoulClauseInput;
    deviceId: string;
    draftAt: string;
    approvedAt: string;
  }
) {
  const source = { client: "user", device_id: input.deviceId };
  const draft = await createSoulProfileDraft(storePath, {
    from_revision_id: input.parentRevisionId,
    clauses: [input.clause],
    source,
    occurred_at: input.draftAt
  });
  return approveSoulProfileDraft(storePath, {
    revision_id: draft.revision.revision_id,
    confirmed: true,
    source,
    occurred_at: input.approvedAt
  });
}

async function compileStore(
  storePath: string,
  binding: { user_profile_id: string; agent_profile_id: string; project_id: string }
) {
  const { revisions } = await readSoulProfileRevisions(storePath);
  return compileEffectiveSoul({ revisions, ...binding });
}

describe("portable Soul through a real Git remote", () => {
  it("preserves effective digests and hook delivery across devices, then exposes concurrent heads safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-git-e2e-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "device-a");
    const storeB = join(root, "device-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-07-20T00:00:00.000Z",
        id: () => "device-a"
      });
      await initializeStore(storeB, {
        now: () => "2026-07-20T00:00:00.000Z",
        id: () => "device-b"
      });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const user = await createApprovedProfile(storeA, {
        subject: { kind: "user", subject_id: "owner" },
        clause: clause("review-style", "Explain consequential tradeoffs before changing shared state."),
        deviceId: "device-a",
        draftAt: "2026-07-20T00:01:00.000Z",
        approvedAt: "2026-07-20T00:02:00.000Z"
      });
      const agent = await createApprovedProfile(storeA, {
        subject: { kind: "agent", subject_id: "codex" },
        clause: clause("persona", "Keep implementation notes concise and evidence backed."),
        deviceId: "device-a",
        draftAt: "2026-07-20T00:03:00.000Z",
        approvedAt: "2026-07-20T00:04:00.000Z"
      });

      await expect(pushGitSync(storeA, { message: "approve portable Soul on device A" })).resolves.toMatchObject({
        ok: true,
        pushed: true
      });
      await expect(pullGitSync(storeB)).resolves.toMatchObject({ ok: true, pulled: true });

      const compilationInput = {
        user_profile_id: user.revision.profile_id,
        agent_profile_id: agent.revision.profile_id,
        project_id: projectId
      };
      const effectiveA = await compileStore(storeA, compilationInput);
      const effectiveB = await compileStore(storeB, compilationInput);

      expect(effectiveA).toMatchObject({ status: "ready", deliverable: true });
      expect(effectiveB).toMatchObject({
        status: "ready",
        deliverable: true,
        source_digest: effectiveA.source_digest,
        rendered_digest: effectiveA.rendered_digest
      });
      expect(effectiveB.selected_revisions.map((revision) => revision.revision_id).sort()).toEqual(
        effectiveA.selected_revisions.map((revision) => revision.revision_id).sort()
      );

      const sessionStart = await runHostHook({
        storePath: storeB,
        project_id: projectId,
        current_task: "Verify portable Soul",
        pull: false,
        hook: {
          host: "codex",
          event: "session_start",
          trigger: "startup",
          session_id: "session-b",
          device_id: "device-b",
          cwd: root,
          occurred_at: "2026-07-20T00:05:00.000Z"
        }
      });
      const postCompact = await runHostHook({
        storePath: storeB,
        project_id: projectId,
        current_task: "Verify portable Soul",
        pull: false,
        hook: {
          host: "codex",
          event: "post_compact",
          session_id: "session-b",
          device_id: "device-b",
          cwd: root,
          occurred_at: "2026-07-20T00:06:00.000Z"
        }
      });
      expect(postCompact).toMatchObject({ action: "defer_to_session_start" });
      const compactSessionStart = await runHostHook({
        storePath: storeB,
        project_id: projectId,
        current_task: "Verify portable Soul",
        pull: false,
        hook: {
          host: "codex",
          event: "session_start",
          trigger: "compact",
          session_id: "session-b",
          device_id: "device-b",
          cwd: root,
          occurred_at: "2026-07-20T00:06:01.000Z"
        }
      });

      for (const result of [sessionStart, compactSessionStart]) {
        expect(result.soul_delivery).toMatchObject({
          delivery: "prepared",
          context: {
            host_context_prepared: true,
            source_digest: effectiveA.source_digest,
            rendered_digest: effectiveA.rendered_digest
          }
        });
        expect(result.hook_output.additional_context).toContain("Explain consequential tradeoffs");
        expect(result.hook_output.additional_context).toContain("evidence backed");
      }

      const branchA = await createApprovedBranch(storeA, {
        parentRevisionId: agent.revision.revision_id,
        clause: clause("persona", "Device A proposes a terse implementation persona."),
        deviceId: "device-a",
        draftAt: "2026-07-20T00:07:00.000Z",
        approvedAt: "2026-07-20T00:08:00.000Z"
      });
      const branchB = await createApprovedBranch(storeB, {
        parentRevisionId: agent.revision.revision_id,
        clause: clause("persona", "Device B proposes a narrative implementation persona."),
        deviceId: "device-b",
        draftAt: "2026-07-20T00:09:00.000Z",
        approvedAt: "2026-07-20T00:10:00.000Z"
      });

      await pushGitSync(storeA, { message: "approve Soul branch on device A" });
      await pushGitSync(storeB, { message: "approve Soul branch on device B" });
      await pullGitSync(storeA);

      const conflictedA = await compileStore(storeA, compilationInput);
      const conflictedB = await compileStore(storeB, compilationInput);
      const competingRevisionIds = [branchA.revision.revision_id, branchB.revision.revision_id].sort();

      for (const effective of [conflictedA, conflictedB]) {
        expect(effective).toMatchObject({
          status: "ready_with_omissions",
          deliverable: true,
          source_digest: effectiveA.source_digest,
          rendered_digest: effectiveA.rendered_digest
        });
        expect(effective.selections_by_profile_id[agent.revision.profile_id]).toMatchObject({
          status: "using_last_known_good",
          selected_revision: { revision_id: agent.revision.revision_id },
          conflicted_revision_ids: competingRevisionIds
        });
        expect(effective.conflicts).toContainEqual(
          expect.objectContaining({
            kind: "ambiguous_active_head",
            profile_id: agent.revision.profile_id,
            revision_ids: competingRevisionIds
          })
        );
        expect(effective.rendered).not.toContain("Device A proposes");
        expect(effective.rendered).not.toContain("Device B proposes");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
