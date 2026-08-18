import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { rebuildDerivedViews } from "./derived.js";
import { execOperationChildProcess } from "./operation-deadline.js";
import { readCurrentRecords } from "./record-read-model.js";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export const REPO_ATLAS_SCHEMA_VERSION = 1 as const;
export const REPO_ATLAS_LENSES = ["onboarding", "request_path", "release_impact"] as const;
export const REPO_ATLAS_DISTRIBUTIONS = ["local_only", "personal_sync", "trusted_team", "public_export"] as const;

export type RepoAtlasLens = (typeof REPO_ATLAS_LENSES)[number];
export type RepoAtlasDistribution = (typeof REPO_ATLAS_DISTRIBUTIONS)[number];
export type RepoAtlasClaimStatus = "active" | "stale";

export interface RepoAtlasPackageManifest {
  package_name?: string;
  scripts: string[];
  runtime_dependencies: string[];
  development_dependencies: string[];
  entrypoints: string[];
}

export interface RepoAtlasObservation {
  observation_id: string;
  kind: "file" | "symlink";
  path: string;
  digest: string;
  bytes: number;
  lines?: number;
  language: string;
  role: "source" | "test" | "documentation" | "configuration" | "asset" | "generated" | "other";
  package_manifest?: RepoAtlasPackageManifest;
  collector: "git-tracked-file-v1";
}

export interface RepoAtlasDelta {
  previous_commit?: string;
  added_paths: string[];
  changed_paths: string[];
  deleted_paths: string[];
  unchanged_paths: number;
}

export interface RepoAtlasSnapshot {
  schema_version: typeof REPO_ATLAS_SCHEMA_VERSION;
  repo_id: string;
  head_commit: string;
  branch: string;
  dirty: boolean;
  workspace_digest: string;
  generated_at: string;
  observations: RepoAtlasObservation[];
  observations_by_path: Record<string, RepoAtlasObservation>;
  delta: RepoAtlasDelta;
  invalidated_claim_ids: string[];
  selection_sources: typeof REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES;
}

export interface RepoAtlasClaimEvidence {
  observation_id: string;
  path: string;
  digest: string;
}

export interface RepoAtlasClaim {
  schema_version: 1;
  claim_id: string;
  repo_id: string;
  statement: string;
  evidence: RepoAtlasClaimEvidence[];
  confidence: number;
  tags: string[];
  status: RepoAtlasClaimStatus;
  verified: {
    commit: string;
    workspace_digest: string;
  };
  invalidated?: {
    commit: string;
    workspace_digest: string;
    paths: string[];
  };
}

export interface ScanRepoAtlasInput {
  store_path: string;
  repo_path: string;
  max_files?: number;
  now?: () => string;
}

export interface AddRepoAtlasClaimInput {
  store_path: string;
  repo_path: string;
  project_id: string;
  statement: string;
  evidence_paths: string[];
  confidence?: number;
  tags?: string[];
  distribution?: RepoAtlasDistribution;
  source: RecordSource;
  now?: () => string;
}

export interface AddRepoAtlasClaimResult {
  claim: RepoAtlasClaim;
  record: MorynRecord;
  created: boolean;
  storage: "synced" | "local";
}

export interface ReadRepoAtlasInput {
  store_path: string;
  repo_path: string;
}

export interface BuildRepoAtlasViewInput extends ReadRepoAtlasInput {
  lens: RepoAtlasLens;
  query?: string;
  limit?: number;
}

export interface RepoAtlasView {
  schema_version: 1;
  lens: RepoAtlasLens;
  repo: {
    repo_id: string;
    head_commit: string;
    branch: string;
    dirty: boolean;
    workspace_digest: string;
  };
  summary: {
    tracked_files: number;
    active_claims: number;
    stale_claims: number;
    languages: Record<string, number>;
    roles: Record<string, number>;
  };
  paths: RepoAtlasObservation[];
  claims: RepoAtlasClaim[];
  delta: RepoAtlasDelta;
  selection_sources: typeof REPO_ATLAS_VIEW_SELECTION_SOURCES;
}

export const REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES = {
  repo_id: "git.remote_identity_digest|git.root_identity_digest",
  head_commit: "git.rev_parse_head",
  branch: "git.symbolic_ref_head",
  dirty: "git.status_porcelain",
  workspace_digest: "observations.canonical_digest",
  observations: "git.ls_files+filesystem.metadata+structured_manifests",
  delta: "previous_snapshot.observations_by_path",
  invalidated_claim_ids: "claims.evidence_digest_mismatch"
} as const;

export const REPO_ATLAS_VIEW_SELECTION_SOURCES = {
  repo: "snapshot.repo",
  summary: "snapshot.observations+claims.status",
  paths: "lens.path_ranking",
  claims: "lens.claim_ranking",
  delta: "snapshot.delta"
} as const;

const DEFAULT_MAX_FILES = 5_000;
const MAX_MAX_FILES = 50_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRYPOINTS = 128;
const STATE_DIRECTORY = join("state", "repo-atlas");
const CLAIM_RECORD_TYPE = "repo_atlas_claim";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid argument: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function boundedMaxFiles(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FILES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MAX_FILES) {
    throw new Error(`Invalid argument: max_files must be an integer between 1 and ${MAX_MAX_FILES}`);
  }
  return value;
}

function safeTrackedPath(path: string): string {
  if (!path || path.startsWith("/") || path.split(/[\\/]/u).some((segment) => segment === "" || segment === "..")) {
    throw new Error("Repository contains an unsafe tracked path");
  }
  return path.split("\\").join("/");
}

async function git(repoPath: string, args: string[], maxOutputBytes = 16 * 1024 * 1024): Promise<string> {
  return (
    await execOperationChildProcess("git", args, {
      cwd: repoPath,
      timeoutMs: 15_000,
      maxOutputBytes
    })
  ).stdout;
}

async function optionalGit(repoPath: string, args: string[]): Promise<string | undefined> {
  try {
    const output = (await git(repoPath, args)).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function repositoryIdentity(repoPath: string): Promise<{ root: string; repo_id: string }> {
  const root = await realpath((await git(repoPath, ["rev-parse", "--show-toplevel"])).trim());
  const remote = await optionalGit(root, ["config", "--get", "remote.origin.url"]);
  const identity = remote ? `remote\u0000${remote.replace(/\/\/[^/@]+@/u, "//")}` : `root\u0000${root}`;
  return { root, repo_id: `repo_${sha256(identity).slice(0, 32)}` };
}

function languageForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const languages: Record<string, string> = {
    ".c": "C",
    ".cc": "C++",
    ".cpp": "C++",
    ".cu": "CUDA",
    ".go": "Go",
    ".h": "C/C++ header",
    ".hpp": "C++ header",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".json": "JSON",
    ".jsx": "JavaScript JSX",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".rb": "Ruby",
    ".rs": "Rust",
    ".sh": "Shell",
    ".toml": "TOML",
    ".ts": "TypeScript",
    ".tsx": "TypeScript JSX",
    ".yaml": "YAML",
    ".yml": "YAML"
  };
  return languages[extension] ?? (extension ? extension.slice(1).toUpperCase() : "Unknown");
}

function roleForPath(path: string): RepoAtlasObservation["role"] {
  const lower = path.toLowerCase();
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/u.test(lower)) return "test";
  if (/(^|\/)(docs?|examples?)(\/|$)|(^|\/)readme(?:\.|$)|\.md$/u.test(lower)) return "documentation";
  if (/(^|\/)(dist|build|coverage|generated|vendor)(\/|$)/u.test(lower)) return "generated";
  if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|mp4|mov)$/u.test(lower)) return "asset";
  if (
    /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|go\.mod|pyproject\.toml|dockerfile|makefile)$/u.test(
      lower
    ) ||
    /\.(json|ya?ml|toml|ini|conf)$/u.test(lower)
  )
    return "configuration";
  if (/(^|\/)(src|lib|app|packages?|cmd|internal)(\/|$)/u.test(lower)) return "source";
  return "other";
}

async function fingerprintRegularFile(path: string): Promise<{ digest: string; bytes: number; lines: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let lines = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      for (const byte of buffer) if (byte === 0x0a) lines += 1;
    });
    stream.once("error", reject);
    stream.once("end", () => resolvePromise({ digest: hash.digest("hex"), bytes, lines }));
  });
}

function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function entrypointStrings(value: unknown, output: string[] = []): string[] {
  if (output.length >= MAX_ENTRYPOINTS) return output;
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const nested of value) entrypointStrings(nested, output);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      entrypointStrings((value as Record<string, unknown>)[key], output);
    }
  }
  return [...new Set(output)].sort().slice(0, MAX_ENTRYPOINTS);
}

async function packageManifest(path: string, bytes: number): Promise<RepoAtlasPackageManifest | undefined> {
  if (!path.endsWith("package.json") || bytes > MAX_MANIFEST_BYTES) return undefined;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof value.name === "string" ? { package_name: value.name } : {}),
      scripts: dependencyNames(value.scripts),
      runtime_dependencies: dependencyNames(value.dependencies),
      development_dependencies: dependencyNames(value.devDependencies),
      entrypoints: entrypointStrings([value.main, value.module, value.bin, value.exports])
    };
  } catch {
    return undefined;
  }
}

async function observeFile(root: string, path: string, repoId: string): Promise<RepoAtlasObservation> {
  const absolute = resolve(root, path);
  const boundary = relative(root, absolute);
  if (boundary.startsWith("..") || boundary.startsWith("/") || boundary === "") {
    throw new Error("Repository contains a path outside its root");
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolute);
    const digest = sha256(target);
    return {
      observation_id: `atlas_obs_${sha256(stableJson({ repoId, path, digest, kind: "symlink" })).slice(0, 32)}`,
      kind: "symlink",
      path,
      digest,
      bytes: Buffer.byteLength(target),
      language: languageForPath(path),
      role: roleForPath(path),
      collector: "git-tracked-file-v1"
    };
  }
  if (!metadata.isFile()) throw new Error(`Tracked path is not a regular file: ${path}`);
  const fingerprint = await fingerprintRegularFile(absolute);
  const manifest = await packageManifest(absolute, fingerprint.bytes);
  return {
    observation_id: `atlas_obs_${sha256(stableJson({ repoId, path, digest: fingerprint.digest, kind: "file" })).slice(0, 32)}`,
    kind: "file",
    path,
    digest: fingerprint.digest,
    bytes: fingerprint.bytes,
    lines: fingerprint.lines,
    language: languageForPath(path),
    role: roleForPath(path),
    ...(manifest ? { package_manifest: manifest } : {}),
    collector: "git-tracked-file-v1"
  };
}

function atlasDirectory(storePath: string, repoId: string): string {
  if (!/^repo_[a-f0-9]{32}$/u.test(repoId)) throw new Error("Invalid Repo Atlas repository identity");
  return join(storePath, STATE_DIRECTORY, repoId);
}

function atlasPath(storePath: string, repoId: string): string {
  return join(atlasDirectory(storePath, repoId), "snapshot.json");
}

async function writeSnapshot(storePath: string, snapshot: RepoAtlasSnapshot): Promise<void> {
  const directory = atlasDirectory(storePath, snapshot.repo_id);
  const path = atlasPath(storePath, snapshot.repo_id);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readSnapshotById(storePath: string, repoId: string): Promise<RepoAtlasSnapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(atlasPath(storePath, repoId), "utf8")) as RepoAtlasSnapshot;
    if (value.schema_version !== 1 || value.repo_id !== repoId || !Array.isArray(value.observations)) {
      throw new Error("Invalid Repo Atlas snapshot");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function claimFromRecord(record: MorynRecord): RepoAtlasClaim | undefined {
  if (record.type !== CLAIM_RECORD_TYPE || record.visibility !== "active") return undefined;
  const candidate = record.content.repo_atlas_claim;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const claim = candidate as RepoAtlasClaim;
  if (
    claim.schema_version !== 1 ||
    claim.claim_id !== record.id ||
    typeof claim.repo_id !== "string" ||
    typeof claim.statement !== "string" ||
    !Array.isArray(claim.evidence) ||
    !Array.isArray(claim.tags) ||
    (claim.status !== "active" && claim.status !== "stale")
  )
    return undefined;
  return claim;
}

async function repoClaims(
  storePath: string,
  repoId: string
): Promise<Array<{ record: MorynRecord; claim: RepoAtlasClaim }>> {
  return (await readCurrentRecords(storePath)).records.flatMap((record) => {
    const claim = claimFromRecord(record);
    return claim?.repo_id === repoId ? [{ record, claim }] : [];
  });
}

function atlasDelta(previous: RepoAtlasSnapshot | undefined, observations: RepoAtlasObservation[]): RepoAtlasDelta {
  const before = previous?.observations_by_path ?? {};
  const after = Object.fromEntries(observations.map((observation) => [observation.path, observation]));
  const addedPaths = observations
    .filter((observation) => before[observation.path] === undefined)
    .map(({ path }) => path);
  const changedPaths = observations
    .filter((observation) => before[observation.path] && before[observation.path]!.digest !== observation.digest)
    .map(({ path }) => path);
  const deletedPaths = Object.keys(before).filter((path) => after[path] === undefined);
  return {
    ...(previous ? { previous_commit: previous.head_commit } : {}),
    added_paths: addedPaths.sort(),
    changed_paths: changedPaths.sort(),
    deleted_paths: deletedPaths.sort(),
    unchanged_paths: observations.length - addedPaths.length - changedPaths.length
  };
}

async function invalidateClaims(
  storePath: string,
  repoId: string,
  headCommit: string,
  workspaceDigest: string,
  observationsByPath: Record<string, RepoAtlasObservation>,
  createdAt: string
): Promise<string[]> {
  const invalidated: string[] = [];
  for (const { record, claim } of await repoClaims(storePath, repoId)) {
    if (claim.status !== "active") continue;
    const invalidatedPaths = claim.evidence
      .filter((evidence) => observationsByPath[evidence.path]?.digest !== evidence.digest)
      .map((evidence) => evidence.path)
      .sort();
    if (invalidatedPaths.length === 0) continue;
    const identity = { repoId, claimId: claim.claim_id, workspaceDigest, invalidatedPaths };
    const event: MorynEvent = {
      event_id: `evt_repo_atlas_invalidate_${sha256(stableJson(identity)).slice(0, 32)}`,
      op: "revise_record",
      record_id: record.id,
      patch: {
        "content.repo_atlas_claim.status": "stale",
        "content.repo_atlas_claim.invalidated": {
          commit: headCommit,
          workspace_digest: workspaceDigest,
          paths: invalidatedPaths
        }
      },
      reason: "Repo Atlas evidence changed or disappeared.",
      created_at: createdAt,
      source: { client: "moryn.repo-atlas" }
    };
    const appended = await appendEventIfAbsent(storePath, event);
    if (appended.created) invalidated.push(record.id);
  }
  if (invalidated.length > 0) await rebuildDerivedViews(storePath);
  return invalidated.sort();
}

export async function scanRepoAtlas(input: ScanRepoAtlasInput): Promise<RepoAtlasSnapshot> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const maxFiles = boundedMaxFiles(input.max_files);
  const generatedAt = (input.now ?? (() => new Date().toISOString()))();
  const { root, repo_id: repoId } = await repositoryIdentity(repoPath);
  const tracked = (await git(root, ["ls-files", "-z"])).split("\u0000").filter(Boolean).map(safeTrackedPath).sort();
  if (tracked.length > maxFiles) {
    throw new Error(`Repo Atlas file limit exceeded: ${tracked.length} tracked files is greater than ${maxFiles}`);
  }
  const observations: RepoAtlasObservation[] = [];
  for (const path of tracked) observations.push(await observeFile(root, path, repoId));
  const observationsByPath = Object.fromEntries(observations.map((observation) => [observation.path, observation]));
  const headCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const branch = (await optionalGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])) ?? "detached";
  const dirty = (await git(root, ["status", "--porcelain=v1", "--untracked-files=no"])).trim().length > 0;
  const workspaceDigest = sha256(
    observations
      .map((observation) => observation.observation_id)
      .sort()
      .join("\n")
  );
  const previous = await readSnapshotById(storePath, repoId);
  const invalidatedClaimIds = await invalidateClaims(
    storePath,
    repoId,
    headCommit,
    workspaceDigest,
    observationsByPath,
    generatedAt
  );
  const snapshot: RepoAtlasSnapshot = {
    schema_version: REPO_ATLAS_SCHEMA_VERSION,
    repo_id: repoId,
    head_commit: headCommit,
    branch,
    dirty,
    workspace_digest: workspaceDigest,
    generated_at: generatedAt,
    observations,
    observations_by_path: observationsByPath,
    delta: atlasDelta(previous, observations),
    invalidated_claim_ids: invalidatedClaimIds,
    selection_sources: REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES
  };
  await writeSnapshot(storePath, snapshot);
  return snapshot;
}

function normalizeStringArray(value: string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid argument: ${name} must contain non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

export async function addRepoAtlasClaim(input: AddRepoAtlasClaimInput): Promise<AddRepoAtlasClaimResult> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const projectId = nonEmptyString(input.project_id, "project_id");
  const statement = nonEmptyString(input.statement, "statement");
  const evidencePaths = normalizeStringArray(input.evidence_paths, "evidence_paths");
  if (evidencePaths.length === 0) throw new Error("Invalid argument: evidence_paths must not be empty");
  const confidence = input.confidence ?? 0.7;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Invalid argument: confidence must be between 0 and 1");
  }
  const distribution = input.distribution ?? "personal_sync";
  if (!REPO_ATLAS_DISTRIBUTIONS.includes(distribution)) throw new Error("Invalid argument: distribution");
  const { repo_id: repoId } = await repositoryIdentity(repoPath);
  const snapshot = await readSnapshotById(storePath, repoId);
  if (!snapshot) throw new Error("Repo Atlas has not been scanned; run a scan before adding claims");
  const evidence = evidencePaths.map((path) => {
    const observation = snapshot.observations_by_path[path];
    if (!observation) throw new Error(`Repo Atlas evidence path not found: ${path}`);
    return { observation_id: observation.observation_id, path, digest: observation.digest };
  });
  const tags = normalizeStringArray(input.tags, "tags");
  const claimDigest = sha256(stableJson({ repoId, statement, evidence, tags }));
  const claimId = `rec_repo_atlas_claim_${claimDigest.slice(0, 32)}`;
  const claim: RepoAtlasClaim = {
    schema_version: 1,
    claim_id: claimId,
    repo_id: repoId,
    statement,
    evidence,
    confidence,
    tags,
    status: "active",
    verified: { commit: snapshot.head_commit, workspace_digest: snapshot.workspace_digest }
  };
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const record: MorynRecord = {
    id: claimId,
    kind: "agent_note",
    type: CLAIM_RECORD_TYPE,
    scope: "project",
    project_id: projectId,
    tags: ["repo-atlas", ...tags],
    content: { text: statement, distribution, repo_atlas_claim: claim },
    state: "candidate",
    confidence,
    priority: "normal",
    visibility: "active",
    created_at: createdAt,
    updated_at: createdAt,
    source: input.source,
    provenance: { method: input.source.client === "user" ? "user-confirmed" : "agent-proposed" }
  };
  const event: MorynEvent = {
    event_id: `evt_repo_atlas_claim_${claimDigest.slice(0, 32)}`,
    op: "upsert_record",
    record,
    created_at: createdAt,
    source: input.source
  };
  const appended = await appendEventIfAbsent(storePath, event);
  if (appended.event.op !== "upsert_record" || appended.event.record.id !== claimId) {
    throw new Error("Repo Atlas claim identity collision");
  }
  if (appended.created) await rebuildDerivedViews(storePath);
  const persisted = claimFromRecord(appended.event.record);
  if (!persisted) throw new Error("Repo Atlas claim could not be read back");
  return { claim: persisted, record: appended.event.record, created: appended.created, storage: appended.storage };
}

export async function readRepoAtlas(input: ReadRepoAtlasInput): Promise<{
  snapshot: RepoAtlasSnapshot;
  claims: RepoAtlasClaim[];
}> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const { repo_id: repoId } = await repositoryIdentity(repoPath);
  const snapshot = await readSnapshotById(storePath, repoId);
  if (!snapshot) throw new Error("Repo Atlas has not been scanned");
  const claims = (await repoClaims(storePath, repoId))
    .map(({ claim }) => claim)
    .sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  return { snapshot, claims };
}

function counts(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length])
  );
}

function queryTokens(query: string | undefined): string[] {
  return [...new Set((query?.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? []).filter((token) => token.length > 1))];
}

function pathScore(observation: RepoAtlasObservation, lens: RepoAtlasLens, tokens: string[]): number {
  const path = observation.path.toLowerCase();
  const tokenScore = tokens.reduce((score, token) => score + (path.includes(token) ? 4 : 0), 0);
  if (lens === "release_impact") return tokenScore;
  if (lens === "request_path") return tokenScore + (observation.role === "source" ? 2 : 0);
  return (
    tokenScore +
    (observation.package_manifest ? 10 : 0) +
    (/^readme(?:\.|$)/iu.test(observation.path) ? 8 : 0) +
    (observation.role === "source" ? 4 : 0) +
    (/(^|\/)(index|main|cli|server)\.[^.]+$/u.test(path) ? 3 : 0)
  );
}

function claimScore(claim: RepoAtlasClaim, lens: RepoAtlasLens, tokens: string[]): number {
  const searchable =
    `${claim.statement} ${claim.tags.join(" ")} ${claim.evidence.map(({ path }) => path).join(" ")}`.toLowerCase();
  const tokenScore = tokens.reduce((score, token) => score + (searchable.includes(token) ? 4 : 0), 0);
  return tokenScore + (lens === "release_impact" && claim.status === "stale" ? 10 : 0) + claim.confidence;
}

export async function buildRepoAtlasView(input: BuildRepoAtlasViewInput): Promise<RepoAtlasView> {
  if (!REPO_ATLAS_LENSES.includes(input.lens)) throw new Error("Invalid argument: Repo Atlas lens");
  const limit = input.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
    throw new Error("Invalid argument: Repo Atlas view limit must be between 1 and 200");
  }
  const { snapshot, claims } = await readRepoAtlas(input);
  const tokens = queryTokens(input.query);
  const impactPaths = new Set([
    ...snapshot.delta.added_paths,
    ...snapshot.delta.changed_paths,
    ...snapshot.delta.deleted_paths
  ]);
  const observations = snapshot.observations
    .filter((observation) => input.lens !== "release_impact" || impactPaths.has(observation.path))
    .map((observation) => ({ observation, score: pathScore(observation, input.lens, tokens) }))
    .filter(({ score }) => input.lens !== "request_path" || tokens.length === 0 || score > 2)
    .sort((left, right) => right.score - left.score || left.observation.path.localeCompare(right.observation.path))
    .slice(0, limit)
    .map(({ observation }) => observation);
  const selectedClaims = claims
    .map((claim) => ({ claim, score: claimScore(claim, input.lens, tokens) }))
    .filter(({ claim, score }) =>
      input.lens === "release_impact"
        ? claim.status === "stale"
        : input.lens !== "request_path" || tokens.length === 0 || score > claim.confidence
    )
    .sort((left, right) => right.score - left.score || left.claim.claim_id.localeCompare(right.claim.claim_id))
    .slice(0, limit)
    .map(({ claim }) => claim);
  return {
    schema_version: 1,
    lens: input.lens,
    repo: {
      repo_id: snapshot.repo_id,
      head_commit: snapshot.head_commit,
      branch: snapshot.branch,
      dirty: snapshot.dirty,
      workspace_digest: snapshot.workspace_digest
    },
    summary: {
      tracked_files: snapshot.observations.length,
      active_claims: claims.filter(({ status }) => status === "active").length,
      stale_claims: claims.filter(({ status }) => status === "stale").length,
      languages: counts(snapshot.observations.map(({ language }) => language)),
      roles: counts(snapshot.observations.map(({ role }) => role))
    },
    paths: observations,
    claims: selectedClaims,
    delta: snapshot.delta,
    selection_sources: REPO_ATLAS_VIEW_SELECTION_SOURCES
  };
}
