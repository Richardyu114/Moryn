import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import {
  addRepoAtlasClaim,
  buildRepoAtlasView,
  readRepoAtlas,
  reverifyRepoAtlasClaim,
  scanRepoAtlas
} from "../../src/core/repo-atlas.js";
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
      schema_version: 2,
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

  it("reuses unchanged observations and exposes parsed symbols and dependency edges", async () => {
    const { repo, store } = await fixture();
    await writeFile(join(repo, "src", "helper.ts"), "export const helper = () => 'ok';\n", "utf8");
    await writeFile(
      join(repo, "src", "server.ts"),
      [
        "import { helper } from './helper.js';",
        "export function serve() { return helper(); }",
        "export function stable() { return 42; }",
        ""
      ].join("\n"),
      "utf8"
    );
    await exec("git", ["add", "src/helper.ts", "src/server.ts"], { cwd: repo });
    await exec("git", ["commit", "-m", "add symbol graph"], { cwd: repo });

    const first = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(first.scan).toMatchObject({ scanned_files: 5, reused_files: 0 });
    expect(first.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/server.ts", qualified_name: "serve", kind: "function" }),
        expect.objectContaining({ path: "src/server.ts", qualified_name: "stable", kind: "function" })
      ])
    );
    expect(first.dependency_edges).toContainEqual(
      expect.objectContaining({
        from_path: "src/server.ts",
        specifier: "./helper.js",
        resolved_path: "src/helper.ts",
        kind: "static_import"
      })
    );

    const second = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(second.scan).toMatchObject({ scanned_files: 0, reused_files: 5 });

    await writeFile(join(repo, "README.md"), "# Atlas fixture updated\n", "utf8");
    await exec("git", ["add", "README.md"], { cwd: repo });
    await exec("git", ["commit", "-m", "change docs"], { cwd: repo });
    const third = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(third.scan).toMatchObject({ scanned_files: 1, reused_files: 4 });
  });

  it("treats an unstaged tracked-file deletion as repository delta evidence", async () => {
    const { repo, store } = await fixture();
    await scanRepoAtlas({ store_path: store, repo_path: repo });

    await rm(join(repo, "src", "server.ts"));
    const deleted = await scanRepoAtlas({ store_path: store, repo_path: repo });

    expect(deleted).toMatchObject({ dirty: true, delta: { deleted_paths: ["src/server.ts"] } });
    expect(deleted.observations_by_path["src/server.ts"]).toBeUndefined();
  });

  it("aggregates TypeScript overload declarations into one change-sensitive symbol", async () => {
    const { repo, store } = await fixture();
    const overloaded = (firstType: string) =>
      [
        `export function convert(value: ${firstType}): string;`,
        "export function convert(value: number): string;",
        "export function convert(value: string | number) { return String(value); }",
        ""
      ].join("\n");
    await writeFile(join(repo, "src", "server.ts"), overloaded("string"), "utf8");
    const first = await scanRepoAtlas({ store_path: store, repo_path: repo });
    const firstSymbols = first.symbols.filter((symbol) => symbol.qualified_name === "convert");
    expect(firstSymbols).toHaveLength(1);

    await writeFile(join(repo, "src", "server.ts"), overloaded("boolean"), "utf8");
    const second = await scanRepoAtlas({ store_path: store, repo_path: repo });
    const secondSymbols = second.symbols.filter((symbol) => symbol.qualified_name === "convert");
    expect(secondSymbols).toHaveLength(1);
    expect(secondSymbols[0]?.digest).not.toBe(firstSymbols[0]?.digest);
    expect(second.delta.changed_symbol_ids).toEqual([firstSymbols[0]?.symbol_id]);
  });

  it("invalidates symbol evidence only when that symbol changes and supports append-only re-verification", async () => {
    const { repo, store } = await fixture();
    await writeFile(
      join(repo, "src", "server.ts"),
      "export function requestPath() { return 'v1'; }\nexport function unrelated() { return 1; }\n",
      "utf8"
    );
    await exec("git", ["add", "src/server.ts"], { cwd: repo });
    await exec("git", ["commit", "-m", "add stable symbols"], { cwd: repo });
    await scanRepoAtlas({ store_path: store, repo_path: repo });
    const added = await addRepoAtlasClaim({
      store_path: store,
      repo_path: repo,
      project_id: "atlas-fixture",
      statement: "requestPath owns request routing.",
      evidence_paths: [],
      evidence_symbols: ["src/server.ts#requestPath"],
      source: { client: "user", device_id: "device_repo_atlas" }
    });

    await writeFile(
      join(repo, "src", "server.ts"),
      "export function requestPath() { return 'v1'; }\nexport function unrelated() { return 2; }\n",
      "utf8"
    );
    await exec("git", ["add", "src/server.ts"], { cwd: repo });
    await exec("git", ["commit", "-m", "change unrelated symbol"], { cwd: repo });
    const unrelated = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(unrelated.delta.changed_paths).toEqual(["src/server.ts"]);
    expect(unrelated.invalidated_claim_ids).toEqual([]);
    expect((await readRepoAtlas({ store_path: store, repo_path: repo })).claims[0]?.status).toBe("active");

    await writeFile(
      join(repo, "src", "server.ts"),
      "export function requestPath() { return 'v2'; }\nexport function unrelated() { return 2; }\n",
      "utf8"
    );
    await exec("git", ["add", "src/server.ts"], { cwd: repo });
    await exec("git", ["commit", "-m", "change claimed symbol"], { cwd: repo });
    const changed = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(changed.invalidated_claim_ids).toEqual([added.claim.claim_id]);
    expect((await readRepoAtlas({ store_path: store, repo_path: repo })).claims[0]?.status).toBe("stale");

    const reverification = await reverifyRepoAtlasClaim({
      store_path: store,
      repo_path: repo,
      claim_id: added.claim.claim_id,
      source: { client: "user", device_id: "device_repo_atlas" }
    });
    expect(reverification).toMatchObject({ revised: true, claim: { status: "active" } });
    expect(reverification.claim.evidence[0]).toMatchObject({
      kind: "symbol",
      path: "src/server.ts",
      qualified_name: "requestPath"
    });
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

  it("upgrades a v1 local snapshot by rescanning instead of reusing evidence without symbols", async () => {
    const { repo, store } = await fixture();
    const current = await scanRepoAtlas({ store_path: store, repo_path: repo });
    const legacy = {
      schema_version: 1,
      repo_id: current.repo_id,
      head_commit: current.head_commit,
      branch: current.branch,
      dirty: current.dirty,
      workspace_digest: current.workspace_digest,
      generated_at: current.generated_at,
      observations: current.observations,
      observations_by_path: current.observations_by_path,
      delta: {
        added_paths: current.delta.added_paths,
        changed_paths: current.delta.changed_paths,
        deleted_paths: current.delta.deleted_paths,
        unchanged_paths: current.delta.unchanged_paths
      },
      invalidated_claim_ids: [],
      selection_sources: current.selection_sources
    };
    await writeFile(
      join(store, "state", "repo-atlas", current.repo_id, "snapshot.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8"
    );

    const upgraded = await scanRepoAtlas({ store_path: store, repo_path: repo });
    expect(upgraded).toMatchObject({
      schema_version: 2,
      scan: { collector: "repo-atlas-v2", scanned_files: 4, reused_files: 0 }
    });
    expect(upgraded.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/server.ts", qualified_name: "serve" })])
    );
  });
});
