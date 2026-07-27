import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { buildDashboardData, renderDashboardHtml, startDashboardServer } from "../../src/observability/dashboard.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

describe("user-facing dashboard safety", () => {
  it("explains a device-only store without also claiming that no action is required", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-local-only" });

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      const html = renderDashboardHtml(data);

      expect(data.sync_assurance.state).toBe("local_only");
      expect(data.action_board.items_by_id.sync).toMatchObject({ value: 1, severity: "info" });
      expect(data.sync.error).toBe("Sync status unavailable");
      expect(JSON.stringify(data)).not.toContain("Not a git repository");
      expect(html).toContain('data-sync-assurance="local_only"');
      expect(html).toContain("Memory is saved on this device only");
      expect(html).toContain("another device cannot recover these memories");
      expect(html).toContain("moryn sync init &lt;remote&gt;");
      expect(html).toContain(
        'data-i18n-en="0 local updates ahead · 0 shared updates waiting" data-i18n-zh="本机领先 0 个更新 · 共享副本有 0 个更新待接收"'
      );
      expect(html).not.toContain('data-editorial-conclusion="no-action-required"');

      const server = await startDashboardServer(storePath, { host: "127.0.0.1", port: 0 });
      try {
        const page = await (await fetch(server.url)).text();
        const api = await (await fetch(new URL("/api/dashboard", server.url))).text();
        expect(page).not.toContain("Not a git repository");
        expect(api).not.toContain("Not a git repository");
        expect(JSON.parse(api).sync.error).toBe("Sync status unavailable");
      } finally {
        await server.close();
      }
    });
  });

  it("shows the project-bound Agent Soul and excludes another active Agent profile", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-soul-binding" });
      const source = { client: "user", device_id: "device-soul-binding", session_id: "soul-setup" };
      const chosenText = "Explain tradeoffs with concrete examples before recommending an action.";
      const otherText = "OTHER_AGENT_PROFILE_MUST_NOT_GUIDE_THIS_PROJECT";
      const chosenDraft = await createSoulProfileDraft(storePath, {
        profile_id: "agent-profile-project",
        subject: { kind: "agent", subject_id: "project-agent", display_name: "Project agent" },
        clauses: [
          {
            clause_key: "communication",
            category: "communication",
            text: chosenText,
            distribution: "personal_sync"
          }
        ],
        source,
        occurred_at: "2026-07-27T01:00:00.000Z"
      });
      const otherDraft = await createSoulProfileDraft(storePath, {
        profile_id: "agent-profile-other",
        subject: { kind: "agent", subject_id: "other-agent", display_name: "Other agent" },
        clauses: [
          {
            clause_key: "communication",
            category: "communication",
            text: otherText,
            distribution: "personal_sync"
          }
        ],
        source,
        occurred_at: "2026-07-27T01:01:00.000Z"
      });
      await approveSoulProfileDraft(storePath, {
        revision_id: chosenDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-27T01:02:00.000Z"
      });
      await approveSoulProfileDraft(storePath, {
        revision_id: otherDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-27T01:03:00.000Z"
      });

      const data = await buildDashboardData(storePath, {
        project_id: "moryn",
        agent_profile_id: chosenDraft.revision.profile_id
      });
      const boot = await createEngine({ storePath }).boot({
        project_id: "moryn",
        agent_profile_id: chosenDraft.revision.profile_id
      });
      const dashboardTexts = data.soul_studio.items.map((item) => item.text);
      const bootTexts = boot.profile.effective_soul.clauses.map((clause) => clause.text);

      expect(data.soul_studio.compilation).toMatchObject({ status: "ready", deliverable: true });
      expect(data.soul_studio.summary.active).toBe(2);
      const chosenActiveRevision = data.soul_studio.profiles.find(
        (profile) => profile.profile_id === chosenDraft.revision.profile_id
      )?.active_revision_id;
      expect(chosenActiveRevision).toBeDefined();
      expect(data.soul_studio.compilation.selected_revision_ids).toEqual([chosenActiveRevision]);
      expect(dashboardTexts).toContain(chosenText);
      expect(dashboardTexts).not.toContain(otherText);
      expect(bootTexts).toContain(chosenText);
      expect(bootTexts).not.toContain(otherText);
      const html = renderDashboardHtml(data);
      expect(html).toContain(chosenText);
      expect(html).toContain("1 approved preference version is in use");
      expect(html).not.toContain("2 approved preference versions are in use");
      expect(html).toMatch(
        /data-i18n-en="\d+ draft · \d+ active · \d+ conflict" data-i18n-zh="\d+ 个草稿 · \d+ 个使用中版本 · \d+ 个冲突版本"/u
      );
    });
  });

  it("keeps Git credentials and raw sync errors out of tunneled HTML and JSON", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-public-sync" });
      await exec("git", ["init", storePath]);
      const credentialMarker = "DASHBOARD_REMOTE_CREDENTIAL_SECRET";
      const queryMarker = "DASHBOARD_REMOTE_QUERY_SECRET";
      const optionMarker = "DASHBOARD_OPTION_REMOTE_SECRET";
      await exec("git", [
        "-C",
        storePath,
        "remote",
        "add",
        "origin",
        `ssh://${credentialMarker}@127.0.0.1:1/memory.git?token=${queryMarker}#private`
      ]);
      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        sync_remote: `ssh://${optionMarker}@127.0.0.1:1/shared.git?token=${optionMarker}#private`
      });
      try {
        const page = await (await fetch(server.url)).text();
        const api = await (await fetch(new URL("/api/dashboard", server.url))).text();
        for (const body of [page, api]) {
          expect(body).not.toContain(credentialMarker);
          expect(body).not.toContain(queryMarker);
          expect(body).not.toContain(optionMarker);
          expect(body).not.toContain("#private");
        }
        expect(JSON.parse(api).sync.remote).toBe("ssh://127.0.0.1:1/memory.git");
      } finally {
        await server.close();
      }
    });
  });

  it("returns a stable tunneled error instead of exposing an internal exception", async () => {
    await withTempStore(async (storePath) => {
      const secretMarker = "DASHBOARD_INTERNAL_PATH_SECRET";
      const invalidStorePath = `${storePath}/${secretMarker}`;
      await writeFile(invalidStorePath, "not a store", "utf8");
      const server = await startDashboardServer(invalidStorePath, { host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(new URL("/api/dashboard", server.url));
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(body).toBe(JSON.stringify({ error: "Dashboard unavailable" }));
        expect(body).not.toContain(secretMarker);
      } finally {
        await server.close();
      }
    });
  });
});
