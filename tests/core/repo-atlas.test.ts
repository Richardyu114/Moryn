import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { addRepoAtlasClaim, buildRepoAtlasView, readRepoAtlas, scanRepoAtlas } from "../../src/core/repo-atlas.js";
import { readLocalEvents, readSyncedEvents } from "../../src/core/store.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moryn-repo-atlas-"));
  roots.push(root);
  const repo = join(root, "repo");
  const store = join(root, "store");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "atlas-fixture",
        main: "dist/server.js",
        bin: { atlas: "dist/cli.js" },
        scripts: { build: "tsc", test: "vitest" },
        dependencies: { commander: "1.0.0" },
        devDependencies: { typescript: "1.0.0" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(join(repo, "src", "server.ts"), "export function serve() { return 'v1'; }\n", "utf8");
  await writeFile(join(repo, "tests", "server.test.ts"), "// server test\n", "utf8");
  await writeFile(join(repo, "README.md"), "# Atlas fixture\n", "utf8");
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Atlas Test"], { cwd: repo });
  await exec("git", ["config", "user.email", "atlas@example.test"], { cwd: repo });
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  await initializeStore(store, {
    now: () => "2026-08-18T00:00:00.000Z",
    id: () => "device_repo_atlas"
  });
  return { root, repo, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence-backed Repo Atlas", () => {
  it("builds content-free observations and structured package evidence", async () => {
    const { root, repo, store } = await fixture();
    const snapshot = await scanRepoAtlas({
      store_path: store,
      repo_path: repo,
      now: () => "2026-08-18T00:01:00.000Z"
    });

    expect(snapshot).toMatchObject({
      schema_version: 1,
      branch: "main",
      dirty: false,
      delta: { added_paths: ["README.md", "package.json", "src/server.ts", "tests/server.test.ts"] }
    });
    expect(snapshot.observations_by_path["src/server.ts"]).toMatchObject({
      language: "TypeScript",
      role: "source",
      collector: "git-tracked-file-v1"
    });
    expect(snapshot.observations_by_path["package.json"]?.package_manifest).toEqual({
      package_name: "atlas-fixture",
      scripts: ["build", "test"],
      runtime_dependencies: ["commander"],
      development_dependencies: ["typescript"],
      entrypoints: ["dist/cli.js", "dist/server.js"]
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("return 'v1'");
  });

  it("persists evidence-bound claims and invalidates them when evidence changes", async () => {
    const { repo, store } = await fixture();
    await scanRepoAtlas({
      store_path: store,
      repo_path: repo,
      now: () => "2026-08-18T00:01:00.000Z"
    });
    const added = await addRepoAtlasClaim({
      store_path: store,
      repo_path: repo,
      project_id: "atlas-fixture",
      statement: "The request enters through src/server.ts.",
      evidence_paths: ["src/server.ts"],
      confidence: 0.9,
      tags: ["request-path"],
      source: { client: "user", device_id: "device_repo_atlas" },
      now: () => "2026-08-18T00:02:00.000Z"
    });

    expect(added).toMatchObject({ created: true, storage: "synced", claim: { status: "active", confidence: 0.9 } });
    const requestView = await buildRepoAtlasView({
      store_path: store,
      repo_path: repo,
      lens: "request_path",
      query: "server"
    });
    expect(requestView.paths.map(({ path }) => path)).toContain("src/server.ts");
    expect(requestView.claims.map(({ claim_id }) => claim_id)).toContain(added.claim.claim_id);

    await writeFile(join(repo, "src", "server.ts"), "export function serve() { return 'v2'; }\n", "utf8");
    await exec("git", ["add", "src/server.ts"], { cwd: repo });
    await exec("git", ["commit", "-m", "change request path"], { cwd: repo });
    const rescanned = await scanRepoAtlas({
      store_path: store,
      repo_path: repo,
      now: () => "2026-08-18T00:03:00.000Z"
    });

    expect(rescanned.delta.changed_paths).toEqual(["src/server.ts"]);
    expect(rescanned.invalidated_claim_ids).toEqual([added.claim.claim_id]);
    const atlas = await readRepoAtlas({ store_path: store, repo_path: repo });
    expect(atlas.claims).toEqual([
      expect.objectContaining({
        claim_id: added.claim.claim_id,
        status: "stale",
        invalidated: expect.objectContaining({ paths: ["src/server.ts"] })
      })
    ]);
    const impact = await buildRepoAtlasView({ store_path: store, repo_path: repo, lens: "release_impact" });
    expect(impact.paths.map(({ path }) => path)).toEqual(["src/server.ts"]);
    expect(impact.claims.map(({ claim_id }) => claim_id)).toEqual([added.claim.claim_id]);
  });

  it("routes local-only claims through the local event journal", async () => {
    const { repo, store } = await fixture();
    await scanRepoAtlas({ store_path: store, repo_path: repo });
    const added = await addRepoAtlasClaim({
      store_path: store,
      repo_path: repo,
      project_id: "atlas-fixture",
      statement: "This architecture note is device-local.",
      evidence_paths: ["package.json"],
      distribution: "local_only",
      source: { client: "test", device_id: "device_repo_atlas" }
    });

    expect(added.storage).toBe("local");
    expect((await readLocalEvents(store)).some((event) => event.event_id.includes("repo_atlas_claim"))).toBe(true);
    expect((await readSyncedEvents(store)).some((event) => event.event_id.includes("repo_atlas_claim"))).toBe(false);
  });
});
