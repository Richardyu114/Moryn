import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { readLocalEvents, readSyncedEvents } from "../../src/core/store.js";
import {
  listWorkspaceMappings,
  removeWorkspaceMapping,
  resolveWorkspacePath,
  setWorkspaceMapping,
  WORKSPACE_MAPPING_REGISTRY_PATH
} from "../../src/core/workspace-mapping.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moryn-workspace-map-"));
  roots.push(root);
  const store = join(root, "store");
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  await writeFile(join(checkout, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  await initializeStore(store, {
    now: () => "2026-08-21T00:00:00.000Z",
    id: () => "device-current"
  });
  return { root, store, checkout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local workspace mappings", () => {
  it("maps an explicit remote Windows root to a verified local checkout without appending events", async () => {
    const { store, checkout } = await fixture();
    const created = await setWorkspaceMapping({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_root: "C:\\Users\\alice\\moryn\\",
      local_root: checkout,
      now: () => "2026-08-21T00:01:00.000Z"
    });

    expect(created).toMatchObject({
      created: true,
      mapping: {
        project_id: "moryn",
        source_device_id: "device-remote",
        source_path_style: "win32",
        source_root: "C:\\Users\\alice\\moryn",
        local_root: checkout
      }
    });
    const resolved = await resolveWorkspacePath({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_path: "C:\\Users\\alice\\moryn\\src\\index.ts"
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      safe_to_access: true,
      local_path: join(checkout, "src", "index.ts"),
      verification: "verified_existing_path"
    });
    expect(await readSyncedEvents(store)).toEqual([]);
    expect(await readLocalEvents(store)).toEqual([]);

    const registry = join(store, WORKSPACE_MAPPING_REGISTRY_PATH);
    expect(JSON.parse(await readFile(registry, "utf8"))).toMatchObject({ version: 1 });
    expect((await lstat(registry)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(store, "state", "workspace-mappings"))).mode & 0o777).toBe(0o700);

    const listed = await listWorkspaceMappings({ store_path: store, project_id: "moryn" });
    expect(listed.mappings).toHaveLength(1);
    expect((await removeWorkspaceMapping({ store_path: store, mapping_id: created.mapping.mapping_id })).removed).toBe(
      true
    );
    expect((await listWorkspaceMappings({ store_path: store })).mappings).toEqual([]);
  });

  it("does not resolve outside the source root or through a local symlink escape", async () => {
    const { root, store, checkout } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "not in checkout\n", "utf8");
    await symlink(outside, join(checkout, "escape"));
    await setWorkspaceMapping({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_root: "/srv/moryn/",
      local_root: checkout
    });

    const unmapped = await resolveWorkspacePath({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_path: "/srv/other/file.ts"
    });
    expect(unmapped).toMatchObject({ status: "unmapped", safe_to_access: false });

    const escaped = await resolveWorkspacePath({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_path: "/srv/moryn/escape/secret.txt"
    });
    expect(escaped).toMatchObject({
      status: "blocked",
      safe_to_access: false,
      verification: "target_escapes_local_root"
    });

    await setWorkspaceMapping({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_root: "/",
      local_root: checkout
    });

    const rootResolved = await resolveWorkspacePath({
      store_path: store,
      project_id: "moryn",
      source_device_id: "device-remote",
      source_path: "/src/index.ts"
    });
    expect(rootResolved).toMatchObject({
      status: "resolved",
      safe_to_access: true,
      local_path: join(checkout, "src", "index.ts")
    });

    await chmod(checkout, 0o755);
  });

  it("serializes concurrent mapping updates without losing either root", async () => {
    const { store, checkout } = await fixture();
    await Promise.all([
      setWorkspaceMapping({
        store_path: store,
        project_id: "moryn",
        source_device_id: "device-a",
        source_root: "/srv/a",
        local_root: checkout
      }),
      setWorkspaceMapping({
        store_path: store,
        project_id: "moryn",
        source_device_id: "device-b",
        source_root: "/srv/b",
        local_root: checkout
      })
    ]);

    expect((await listWorkspaceMappings({ store_path: store, project_id: "moryn" })).mappings).toHaveLength(2);
  });
});
