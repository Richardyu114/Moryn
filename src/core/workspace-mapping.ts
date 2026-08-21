import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { withStoreStateLease } from "./state-lease.js";

export const WORKSPACE_MAPPING_VERSION = 1 as const;
export const WORKSPACE_MAPPING_REGISTRY_PATH = "state/workspace-mappings/mappings.json" as const;
export const WORKSPACE_PATH_STYLES = ["posix", "win32"] as const;

export type WorkspacePathStyle = (typeof WORKSPACE_PATH_STYLES)[number];
export type WorkspacePathVerification =
  | "verified_existing_path"
  | "target_missing"
  | "local_root_unavailable"
  | "target_escapes_local_root";

export interface WorkspaceMapping {
  version: typeof WORKSPACE_MAPPING_VERSION;
  mapping_id: string;
  project_id: string;
  source_device_id: string;
  source_path_style: WorkspacePathStyle;
  source_root: string;
  local_root: string;
  created_at: string;
  updated_at: string;
}

interface WorkspaceMappingRegistry {
  version: typeof WORKSPACE_MAPPING_VERSION;
  mappings: WorkspaceMapping[];
}

export interface SetWorkspaceMappingInput {
  store_path: string;
  project_id: string;
  source_device_id: string;
  source_root: string;
  local_root: string;
  now?: () => string;
}

export interface ListWorkspaceMappingsInput {
  store_path: string;
  project_id?: string;
  source_device_id?: string;
}

export interface RemoveWorkspaceMappingInput {
  store_path: string;
  mapping_id: string;
}

export interface ResolveWorkspacePathInput {
  store_path: string;
  project_id: string;
  source_device_id: string;
  source_path: string;
}

export interface WorkspacePathResolution {
  version: typeof WORKSPACE_MAPPING_VERSION;
  status: "resolved" | "unmapped" | "unresolved" | "blocked";
  safe_to_access: boolean;
  project_id: string;
  source_device_id: string;
  source_path: string;
  source_path_style: WorkspacePathStyle;
  mapping?: WorkspaceMapping;
  local_path?: string;
  verification?: WorkspacePathVerification;
  selection_sources: typeof WORKSPACE_PATH_RESOLUTION_SELECTION_SOURCES;
}

export const WORKSPACE_MAPPING_SELECTION_SOURCES = {
  mappings: "local_state.workspace_mappings",
  mapping_id: "project_id+source_device_id+normalized_source_root",
  local_root: "verified_local_realpath"
} as const;

export const WORKSPACE_PATH_RESOLUTION_SELECTION_SOURCES = {
  mapping: "longest_explicit_source_root_match",
  local_path: "mapping.local_root+source_relative_path",
  verification: "filesystem.realpath_boundary_check",
  safe_to_access: "verification.verified_existing_path"
} as const;

const MAPPING_ID_PATTERN = /^workspace_map_[a-f0-9]{32}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid workspace mapping: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Invalid workspace mapping: timestamp must be a canonical ISO string");
  }
  return value;
}

function pathStyle(value: string): WorkspacePathStyle {
  if (win32.isAbsolute(value) && (/^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\"))) return "win32";
  if (posix.isAbsolute(value)) return "posix";
  throw new Error("Invalid workspace mapping: source path must be absolute POSIX or Windows path");
}

function sourcePathModule(style: WorkspacePathStyle): typeof posix | typeof win32 {
  return style === "win32" ? win32 : posix;
}

function normalizeSourcePath(
  value: string,
  expectedStyle?: WorkspacePathStyle
): {
  style: WorkspacePathStyle;
  path: string;
} {
  const style = pathStyle(value);
  if (expectedStyle && style !== expectedStyle) {
    throw new Error("Invalid workspace mapping: source path style does not match mapping root");
  }
  const module = sourcePathModule(style);
  const root = module.parse(value).root;
  let normalized = module.normalize(value);
  while (normalized.length > root.length && normalized.endsWith(module.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return { style, path: normalized };
}

function sourcePathKey(value: string, style: WorkspacePathStyle): string {
  return style === "win32" ? value.toLowerCase() : value;
}

function sourceContains(root: string, candidate: string, style: WorkspacePathStyle): boolean {
  const module = sourcePathModule(style);
  const rootKey = sourcePathKey(root, style);
  const candidateKey = sourcePathKey(candidate, style);
  const prefix = rootKey.endsWith(module.sep) ? rootKey : `${rootKey}${module.sep}`;
  return candidateKey === rootKey || candidateKey.startsWith(prefix);
}

function localContains(root: string, candidate: string): boolean {
  const boundary = relative(root, candidate);
  return boundary === "" || (!boundary.startsWith("..") && !isAbsolute(boundary));
}

function mappingIdentity(
  projectId: string,
  sourceDeviceId: string,
  sourceRoot: string,
  style: WorkspacePathStyle
): string {
  return `workspace_map_${sha256(JSON.stringify({ projectId, sourceDeviceId, sourceRoot, style })).slice(0, 32)}`;
}

function registryPath(storePath: string): string {
  return resolve(nonEmpty(storePath, "store_path"), WORKSPACE_MAPPING_REGISTRY_PATH);
}

function parseMapping(value: unknown): WorkspaceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspace mapping registry: mapping must be an object");
  }
  const candidate = value as Partial<WorkspaceMapping>;
  const projectId = nonEmpty(candidate.project_id, "project_id");
  const sourceDeviceId = nonEmpty(candidate.source_device_id, "source_device_id");
  const normalized = normalizeSourcePath(nonEmpty(candidate.source_root, "source_root"));
  const localRoot = nonEmpty(candidate.local_root, "local_root");
  if (!isAbsolute(localRoot)) throw new Error("Invalid workspace mapping registry: local_root must be absolute");
  const expectedId = mappingIdentity(projectId, sourceDeviceId, normalized.path, normalized.style);
  if (
    candidate.version !== WORKSPACE_MAPPING_VERSION ||
    candidate.mapping_id !== expectedId ||
    candidate.source_path_style !== normalized.style
  ) {
    throw new Error("Invalid workspace mapping registry: mapping identity mismatch");
  }
  return {
    version: WORKSPACE_MAPPING_VERSION,
    mapping_id: expectedId,
    project_id: projectId,
    source_device_id: sourceDeviceId,
    source_path_style: normalized.style,
    source_root: normalized.path,
    local_root: resolve(localRoot),
    created_at: canonicalTimestamp(nonEmpty(candidate.created_at, "created_at")),
    updated_at: canonicalTimestamp(nonEmpty(candidate.updated_at, "updated_at"))
  };
}

async function readRegistry(storePath: string): Promise<WorkspaceMappingRegistry> {
  try {
    const value = JSON.parse(await readFile(registryPath(storePath), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("registry must be an object");
    const candidate = value as { version?: unknown; mappings?: unknown };
    if (candidate.version !== WORKSPACE_MAPPING_VERSION || !Array.isArray(candidate.mappings)) {
      throw new Error("unsupported registry version");
    }
    return {
      version: WORKSPACE_MAPPING_VERSION,
      mappings: candidate.mappings
        .map(parseMapping)
        .sort((left, right) => left.mapping_id.localeCompare(right.mapping_id))
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: WORKSPACE_MAPPING_VERSION, mappings: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid workspace mapping registry: ${message}`);
  }
}

async function writeRegistry(storePath: string, registry: WorkspaceMappingRegistry): Promise<void> {
  const path = registryPath(storePath);
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifiedLocalRoot(value: string): Promise<string> {
  const localRoot = nonEmpty(value, "local_root");
  if (!isAbsolute(localRoot)) throw new Error("Invalid workspace mapping: local_root must be absolute");
  const canonical = await realpath(localRoot).catch(() => {
    throw new Error("Invalid workspace mapping: local_root does not exist");
  });
  if (!(await lstat(canonical)).isDirectory()) {
    throw new Error("Invalid workspace mapping: local_root must be a directory");
  }
  return canonical;
}

async function setWorkspaceMappingUnlocked(input: SetWorkspaceMappingInput): Promise<{
  created: boolean;
  replaced: boolean;
  mapping: WorkspaceMapping;
  selection_sources: typeof WORKSPACE_MAPPING_SELECTION_SOURCES;
}> {
  const projectId = nonEmpty(input.project_id, "project_id");
  const sourceDeviceId = nonEmpty(input.source_device_id, "source_device_id");
  const source = normalizeSourcePath(nonEmpty(input.source_root, "source_root"));
  const localRoot = await verifiedLocalRoot(input.local_root);
  const timestamp = canonicalTimestamp((input.now ?? (() => new Date().toISOString()))());
  const registry = await readRegistry(input.store_path);
  const mappingId = mappingIdentity(projectId, sourceDeviceId, source.path, source.style);
  const existing = registry.mappings.find((mapping) => mapping.mapping_id === mappingId);
  const mapping: WorkspaceMapping = {
    version: WORKSPACE_MAPPING_VERSION,
    mapping_id: mappingId,
    project_id: projectId,
    source_device_id: sourceDeviceId,
    source_path_style: source.style,
    source_root: source.path,
    local_root: localRoot,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  };
  const mappings = [...registry.mappings.filter((candidate) => candidate.mapping_id !== mappingId), mapping].sort(
    (left, right) => left.mapping_id.localeCompare(right.mapping_id)
  );
  await writeRegistry(input.store_path, { version: WORKSPACE_MAPPING_VERSION, mappings });
  return {
    created: existing === undefined,
    replaced: existing !== undefined && existing.local_root !== mapping.local_root,
    mapping,
    selection_sources: WORKSPACE_MAPPING_SELECTION_SOURCES
  };
}

export async function setWorkspaceMapping(input: SetWorkspaceMappingInput): Promise<{
  created: boolean;
  replaced: boolean;
  mapping: WorkspaceMapping;
  selection_sources: typeof WORKSPACE_MAPPING_SELECTION_SOURCES;
}> {
  return withStoreStateLease(input.store_path, () => setWorkspaceMappingUnlocked(input));
}

export async function listWorkspaceMappings(input: ListWorkspaceMappingsInput): Promise<{
  version: typeof WORKSPACE_MAPPING_VERSION;
  mappings: WorkspaceMapping[];
  selection_sources: typeof WORKSPACE_MAPPING_SELECTION_SOURCES;
}> {
  const registry = await readRegistry(input.store_path);
  const projectId = input.project_id ? nonEmpty(input.project_id, "project_id") : undefined;
  const sourceDeviceId = input.source_device_id ? nonEmpty(input.source_device_id, "source_device_id") : undefined;
  return {
    version: WORKSPACE_MAPPING_VERSION,
    mappings: registry.mappings.filter(
      (mapping) =>
        (!projectId || mapping.project_id === projectId) &&
        (!sourceDeviceId || mapping.source_device_id === sourceDeviceId)
    ),
    selection_sources: WORKSPACE_MAPPING_SELECTION_SOURCES
  };
}

async function removeWorkspaceMappingUnlocked(input: RemoveWorkspaceMappingInput): Promise<{
  removed: boolean;
  mapping_id: string;
  selection_sources: typeof WORKSPACE_MAPPING_SELECTION_SOURCES;
}> {
  const mappingId = nonEmpty(input.mapping_id, "mapping_id");
  if (!MAPPING_ID_PATTERN.test(mappingId)) throw new Error("Invalid workspace mapping: mapping_id");
  const registry = await readRegistry(input.store_path);
  const mappings = registry.mappings.filter((mapping) => mapping.mapping_id !== mappingId);
  if (mappings.length !== registry.mappings.length) {
    await writeRegistry(input.store_path, { version: WORKSPACE_MAPPING_VERSION, mappings });
  }
  return {
    removed: mappings.length !== registry.mappings.length,
    mapping_id: mappingId,
    selection_sources: WORKSPACE_MAPPING_SELECTION_SOURCES
  };
}

export async function removeWorkspaceMapping(input: RemoveWorkspaceMappingInput): Promise<{
  removed: boolean;
  mapping_id: string;
  selection_sources: typeof WORKSPACE_MAPPING_SELECTION_SOURCES;
}> {
  return withStoreStateLease(input.store_path, () => removeWorkspaceMappingUnlocked(input));
}

export async function resolveWorkspacePath(input: ResolveWorkspacePathInput): Promise<WorkspacePathResolution> {
  const projectId = nonEmpty(input.project_id, "project_id");
  const sourceDeviceId = nonEmpty(input.source_device_id, "source_device_id");
  const source = normalizeSourcePath(nonEmpty(input.source_path, "source_path"));
  const registry = await readRegistry(input.store_path);
  const candidates = registry.mappings
    .filter(
      (mapping) =>
        mapping.project_id === projectId &&
        mapping.source_device_id === sourceDeviceId &&
        mapping.source_path_style === source.style &&
        sourceContains(mapping.source_root, source.path, source.style)
    )
    .sort(
      (left, right) =>
        right.source_root.length - left.source_root.length || left.mapping_id.localeCompare(right.mapping_id)
    );
  const common = {
    version: WORKSPACE_MAPPING_VERSION,
    project_id: projectId,
    source_device_id: sourceDeviceId,
    source_path: source.path,
    source_path_style: source.style,
    selection_sources: WORKSPACE_PATH_RESOLUTION_SELECTION_SOURCES
  } as const;
  const mapping = candidates[0];
  if (!mapping) return { ...common, status: "unmapped", safe_to_access: false };

  const sourceModule = sourcePathModule(source.style);
  const relativeSource = sourceModule.relative(mapping.source_root, source.path);
  const segments = relativeSource ? relativeSource.split(sourceModule.sep).filter(Boolean) : [];
  const localPath = resolve(mapping.local_root, ...segments);
  if (!localContains(mapping.local_root, localPath)) {
    return {
      ...common,
      status: "blocked",
      safe_to_access: false,
      mapping,
      local_path: localPath,
      verification: "target_escapes_local_root"
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(mapping.local_root);
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ...common,
      status: "blocked",
      safe_to_access: false,
      mapping,
      local_path: localPath,
      verification: "local_root_unavailable"
    };
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(localPath);
  } catch {
    return {
      ...common,
      status: "unresolved",
      safe_to_access: false,
      mapping,
      local_path: localPath,
      verification: "target_missing"
    };
  }
  if (!localContains(canonicalRoot, canonicalTarget)) {
    return {
      ...common,
      status: "blocked",
      safe_to_access: false,
      mapping,
      local_path: localPath,
      verification: "target_escapes_local_root"
    };
  }
  return {
    ...common,
    status: "resolved",
    safe_to_access: true,
    mapping,
    local_path: canonicalTarget,
    verification: "verified_existing_path"
  };
}
