import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { readStoreConfig } from "./config.js";
import { rebuildDerivedViews } from "./derived.js";
import { execOperationChildProcess } from "./operation-deadline.js";
import { readCurrentRecords } from "./record-read-model.js";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export const REPO_ATLAS_SCHEMA_VERSION = 2 as const;
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

export type RepoAtlasSymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "variable";

export interface RepoAtlasSymbolObservation {
  symbol_id: string;
  path: string;
  name: string;
  qualified_name: string;
  kind: RepoAtlasSymbolKind;
  exported: boolean;
  start_line: number;
  end_line: number;
  digest: string;
  collector: "babel-parser-v1";
}

export type RepoAtlasDependencyKind = "static_import" | "dynamic_import" | "require" | "re_export";

export interface RepoAtlasDependencyEdge {
  edge_id: string;
  from_path: string;
  specifier: string;
  resolved_path?: string;
  external: boolean;
  kind: RepoAtlasDependencyKind;
  collector: "babel-parser-v1";
}

export interface RepoAtlasDelta {
  previous_commit?: string;
  added_paths: string[];
  changed_paths: string[];
  deleted_paths: string[];
  unchanged_paths: number;
  added_symbol_ids: string[];
  changed_symbol_ids: string[];
  deleted_symbol_ids: string[];
  added_dependency_edge_ids: string[];
  deleted_dependency_edge_ids: string[];
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
  symbols: RepoAtlasSymbolObservation[];
  symbols_by_id: Record<string, RepoAtlasSymbolObservation>;
  dependency_edges: RepoAtlasDependencyEdge[];
  dirty_paths: string[];
  scan: {
    collector: "repo-atlas-v2" | "legacy-file-v1";
    scanned_files: number;
    reused_files: number;
    parsed_files: number;
    parser_skipped_paths: string[];
    parser_failed_paths: string[];
  };
  delta: RepoAtlasDelta;
  invalidated_claim_ids: string[];
  selection_sources: typeof REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES;
}

export interface RepoAtlasClaimEvidence {
  kind: "file" | "symbol";
  observation_id: string;
  path: string;
  digest: string;
  symbol_id?: string;
  qualified_name?: string;
}

export interface RepoAtlasClaim {
  schema_version: 1 | 2;
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
    symbol_ids?: string[];
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
  evidence_symbols?: string[];
  confidence?: number;
  tags?: string[];
  distribution?: RepoAtlasDistribution;
  source: RecordSource;
  now?: () => string;
}

export interface ReverifyRepoAtlasClaimInput {
  store_path: string;
  repo_path: string;
  claim_id: string;
  source: RecordSource;
  now?: () => string;
}

export interface ReverifyRepoAtlasClaimResult {
  claim: RepoAtlasClaim;
  record: MorynRecord;
  revised: boolean;
  storage: "synced" | "local";
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
    symbols: number;
    dependency_edges: number;
  };
  paths: RepoAtlasObservation[];
  symbols: RepoAtlasSymbolObservation[];
  dependency_edges: RepoAtlasDependencyEdge[];
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
  symbols: "babel_parser.ast_declarations",
  dependency_edges: "babel_parser.ast_module_edges",
  scan: "git_diff+working_tree_delta+previous_snapshot",
  delta: "previous_snapshot.observations_by_path",
  invalidated_claim_ids: "claims.evidence_digest_mismatch"
} as const;

export const REPO_ATLAS_VIEW_SELECTION_SOURCES = {
  repo: "snapshot.repo",
  summary: "snapshot.observations+claims.status",
  paths: "lens.path_ranking",
  symbols: "lens.symbol_ranking",
  dependency_edges: "lens.dependency_edge_ranking",
  claims: "lens.claim_ranking",
  delta: "snapshot.delta"
} as const;

const DEFAULT_MAX_FILES = 5_000;
const MAX_MAX_FILES = 50_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRYPOINTS = 128;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
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
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Repository contains an unsafe tracked path");
  }
  return path;
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
    ".cts": "TypeScript",
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
    ".mts": "TypeScript",
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
  if (boundary === "" || boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
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

interface BabelNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start?: { line?: number }; end?: { line?: number } } | null;
  [key: string]: unknown;
}

interface SourceAnalysis {
  symbols: RepoAtlasSymbolObservation[];
  dependency_edges: RepoAtlasDependencyEdge[];
  parsed: boolean;
  skipped: boolean;
  failed: boolean;
}

function babelNode(value: unknown): BabelNode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (value as BabelNode) : undefined;
}

function nodeName(value: unknown): string | undefined {
  const node = babelNode(value);
  if (!node) return undefined;
  if (node.type === "Identifier" || node.type === "PrivateName") {
    const nested = node.type === "PrivateName" ? babelNode(node.id) : node;
    return typeof nested?.name === "string" ? nested.name : undefined;
  }
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return undefined;
}

function stringLiteral(value: unknown): string | undefined {
  const node = babelNode(value);
  return node?.type === "StringLiteral" && typeof node.value === "string" ? node.value : undefined;
}

function sourceSymbol(
  repoId: string,
  path: string,
  source: string,
  node: BabelNode,
  name: string,
  qualifiedName: string,
  kind: RepoAtlasSymbolKind,
  exported: boolean
): RepoAtlasSymbolObservation | undefined {
  if (
    typeof node.start !== "number" ||
    typeof node.end !== "number" ||
    typeof node.loc?.start?.line !== "number" ||
    typeof node.loc?.end?.line !== "number"
  ) {
    return undefined;
  }
  const symbolId = `atlas_symbol_${sha256(stableJson({ repoId, path, qualifiedName, kind })).slice(0, 32)}`;
  return {
    symbol_id: symbolId,
    path,
    name,
    qualified_name: qualifiedName,
    kind,
    exported,
    start_line: node.loc.start.line,
    end_line: node.loc.end.line,
    digest: sha256(source.slice(node.start, node.end)),
    collector: "babel-parser-v1"
  };
}

function collectDeclarationSymbols(
  output: RepoAtlasSymbolObservation[],
  input: {
    repo_id: string;
    path: string;
    source: string;
    node: BabelNode;
    exported: boolean;
    exported_names: ReadonlySet<string>;
  }
): void {
  const { node } = input;
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    const declaration = babelNode(node.declaration);
    if (declaration) {
      collectDeclarationSymbols(output, {
        ...input,
        node: declaration,
        exported: true
      });
    }
    return;
  }

  const add = (target: BabelNode, name: string, kind: RepoAtlasSymbolKind, qualifiedName = name): void => {
    const symbol = sourceSymbol(
      input.repo_id,
      input.path,
      input.source,
      target,
      name,
      qualifiedName,
      kind,
      input.exported || input.exported_names.has(name)
    );
    if (symbol) output.push(symbol);
  };

  if (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") {
    add(node, nodeName(node.id) ?? "default", "function");
    return;
  }
  if (node.type === "ClassDeclaration") {
    const name = nodeName(node.id) ?? "default";
    add(node, name, "class");
    const body = babelNode(node.body);
    const members = Array.isArray(body?.body) ? body.body : [];
    for (const value of members) {
      const member = babelNode(value);
      if (!member || (member.type !== "ClassMethod" && member.type !== "ClassPrivateMethod")) continue;
      const memberName = nodeName(member.key);
      if (memberName) add(member, memberName, "method", `${name}.${memberName}`);
    }
    return;
  }
  const directKinds: Partial<Record<string, RepoAtlasSymbolKind>> = {
    TSInterfaceDeclaration: "interface",
    TSTypeAliasDeclaration: "type",
    TSEnumDeclaration: "enum"
  };
  const directKind = directKinds[node.type];
  if (directKind) {
    const name = nodeName(node.id);
    if (name) add(node, name, directKind);
    return;
  }
  if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
    for (const value of node.declarations) {
      const declaration = babelNode(value);
      if (!declaration) continue;
      const name = nodeName(declaration.id);
      if (!name) continue;
      const initializer = babelNode(declaration.init);
      const kind =
        initializer?.type === "ArrowFunctionExpression" || initializer?.type === "FunctionExpression"
          ? "function"
          : "variable";
      add(declaration, name, kind);
    }
  }
}

function dependencyResolutionCandidates(fromPath: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const extension = posix.extname(base);
  const withoutExtension = extension ? base.slice(0, -extension.length) : base;
  const candidates = [base];
  if (!extension) {
    for (const suffix of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(`${base}${suffix}`, `${base}/index${suffix}`);
    }
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(`${withoutExtension}${suffix}`);
  }
  return [...new Set(candidates.map((candidate) => candidate.replace(/^\.\//u, "")))];
}

function dependencyEdge(
  repoId: string,
  fromPath: string,
  specifier: string,
  kind: RepoAtlasDependencyKind,
  tracked: ReadonlySet<string>
): RepoAtlasDependencyEdge {
  const resolvedPath = specifier.startsWith(".")
    ? dependencyResolutionCandidates(fromPath, specifier).find((candidate) => tracked.has(candidate))
    : undefined;
  const external = !specifier.startsWith(".");
  const edgeId = `atlas_edge_${sha256(stableJson({ repoId, fromPath, specifier, kind, resolvedPath, external })).slice(0, 32)}`;
  return {
    edge_id: edgeId,
    from_path: fromPath,
    specifier,
    ...(resolvedPath ? { resolved_path: resolvedPath } : {}),
    external,
    kind,
    collector: "babel-parser-v1"
  };
}

function walkAst(value: unknown, visit: (node: BabelNode) => void): void {
  if (Array.isArray(value)) {
    for (const nested of value) walkAst(nested, visit);
    return;
  }
  const node = babelNode(value);
  if (!node) return;
  visit(node);
  for (const [key, nested] of Object.entries(node)) {
    if (["loc", "start", "end", "type", "leadingComments", "trailingComments", "innerComments"].includes(key)) {
      continue;
    }
    if (Array.isArray(nested) || babelNode(nested)) walkAst(nested, visit);
  }
}

function aggregateSymbols(symbols: RepoAtlasSymbolObservation[]): RepoAtlasSymbolObservation[] {
  const grouped = new Map<string, RepoAtlasSymbolObservation[]>();
  for (const symbol of symbols) {
    grouped.set(symbol.symbol_id, [...(grouped.get(symbol.symbol_id) ?? []), symbol]);
  }
  return [...grouped.values()]
    .map((group) => {
      const first = group[0]!;
      if (group.length === 1) return first;
      return {
        ...first,
        exported: group.some((symbol) => symbol.exported),
        start_line: Math.min(...group.map((symbol) => symbol.start_line)),
        end_line: Math.max(...group.map((symbol) => symbol.end_line)),
        digest: sha256(stableJson(group.map((symbol) => symbol.digest).sort()))
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path) || left.start_line - right.start_line);
}

function supportedParserPath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/u.test(path);
}

async function analyzeSource(
  root: string,
  path: string,
  observation: RepoAtlasObservation,
  repoId: string,
  tracked: ReadonlySet<string>
): Promise<SourceAnalysis> {
  if (!supportedParserPath(path) || observation.kind !== "file") {
    return { symbols: [], dependency_edges: [], parsed: false, skipped: false, failed: false };
  }
  if (observation.bytes > MAX_PARSE_BYTES) {
    return { symbols: [], dependency_edges: [], parsed: false, skipped: true, failed: false };
  }
  const source = await readFile(resolve(root, path), "utf8");
  try {
    const isTypeScript = /\.(?:[cm]?ts|tsx)$/u.test(path);
    const isJsx = /\.(?:jsx|tsx)$/u.test(path);
    const ast = parse(source, {
      sourceType: "unambiguous",
      plugins: [
        ...(isTypeScript ? (["typescript"] as const) : []),
        ...(isJsx ? (["jsx"] as const) : []),
        "decorators-legacy"
      ]
    }) as unknown as BabelNode;
    const program = babelNode(ast.program);
    const body = Array.isArray(program?.body) ? program.body : [];
    const exportedNames = new Set<string>();
    for (const value of body) {
      const node = babelNode(value);
      if (node?.type !== "ExportNamedDeclaration" || !Array.isArray(node.specifiers)) continue;
      for (const specifierValue of node.specifiers) {
        const specifier = babelNode(specifierValue);
        const localName = nodeName(specifier?.local);
        if (localName) exportedNames.add(localName);
      }
    }
    const symbols: RepoAtlasSymbolObservation[] = [];
    for (const value of body) {
      const node = babelNode(value);
      if (node) {
        collectDeclarationSymbols(symbols, {
          repo_id: repoId,
          path,
          source,
          node,
          exported: false,
          exported_names: exportedNames
        });
      }
    }

    const edges = new Map<string, RepoAtlasDependencyEdge>();
    const addEdge = (specifier: string | undefined, kind: RepoAtlasDependencyKind): void => {
      if (!specifier) return;
      const edge = dependencyEdge(repoId, path, specifier, kind, tracked);
      edges.set(edge.edge_id, edge);
    };
    for (const value of body) {
      const node = babelNode(value);
      if (!node) continue;
      if (node.type === "ImportDeclaration") addEdge(stringLiteral(node.source), "static_import");
      if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
        addEdge(stringLiteral(node.source), "re_export");
      }
    }
    walkAst(program, (node) => {
      if (node.type === "ImportExpression") addEdge(stringLiteral(node.source), "dynamic_import");
      if (node.type !== "CallExpression") return;
      const callee = babelNode(node.callee);
      const firstArgument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
      if (callee?.type === "Import") addEdge(stringLiteral(firstArgument), "dynamic_import");
      if (callee?.type === "Identifier" && callee.name === "require") {
        addEdge(stringLiteral(firstArgument), "require");
      }
    });
    return {
      symbols: aggregateSymbols(symbols),
      dependency_edges: [...edges.values()].sort((left, right) => left.edge_id.localeCompare(right.edge_id)),
      parsed: true,
      skipped: false,
      failed: false
    };
  } catch {
    return { symbols: [], dependency_edges: [], parsed: false, skipped: false, failed: true };
  }
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
    const value = JSON.parse(await readFile(atlasPath(storePath, repoId), "utf8")) as Omit<
      Partial<RepoAtlasSnapshot>,
      "schema_version"
    > & { schema_version?: number };
    if (
      (value.schema_version !== 1 && value.schema_version !== 2) ||
      value.repo_id !== repoId ||
      !Array.isArray(value.observations)
    ) {
      throw new Error("Invalid Repo Atlas snapshot");
    }
    const observationsByPath =
      value.observations_by_path ??
      Object.fromEntries(value.observations.map((observation) => [observation.path, observation]));
    const symbols = value.schema_version === 2 && Array.isArray(value.symbols) ? value.symbols : [];
    const dependencyEdges =
      value.schema_version === 2 && Array.isArray(value.dependency_edges) ? value.dependency_edges : [];
    const rawDelta = value.delta as Partial<RepoAtlasDelta> | undefined;
    const legacyDelta: RepoAtlasDelta = {
      ...(rawDelta?.previous_commit ? { previous_commit: rawDelta.previous_commit } : {}),
      added_paths: rawDelta?.added_paths ?? [],
      changed_paths: rawDelta?.changed_paths ?? [],
      deleted_paths: rawDelta?.deleted_paths ?? [],
      unchanged_paths: rawDelta?.unchanged_paths ?? value.observations.length,
      added_symbol_ids: rawDelta?.added_symbol_ids ?? [],
      changed_symbol_ids: rawDelta?.changed_symbol_ids ?? [],
      deleted_symbol_ids: rawDelta?.deleted_symbol_ids ?? [],
      added_dependency_edge_ids: rawDelta?.added_dependency_edge_ids ?? [],
      deleted_dependency_edge_ids: rawDelta?.deleted_dependency_edge_ids ?? []
    };
    return {
      schema_version: REPO_ATLAS_SCHEMA_VERSION,
      repo_id: repoId,
      head_commit: nonEmptyString(value.head_commit, "snapshot.head_commit"),
      branch: nonEmptyString(value.branch, "snapshot.branch"),
      dirty: value.dirty === true,
      workspace_digest: nonEmptyString(value.workspace_digest, "snapshot.workspace_digest"),
      generated_at: nonEmptyString(value.generated_at, "snapshot.generated_at"),
      observations: value.observations,
      observations_by_path: observationsByPath,
      symbols,
      symbols_by_id: Object.fromEntries(symbols.map((symbol) => [symbol.symbol_id, symbol])),
      dependency_edges: dependencyEdges,
      dirty_paths: value.schema_version === 2 && Array.isArray(value.dirty_paths) ? value.dirty_paths : [],
      scan:
        value.schema_version === 2 && value.scan
          ? value.scan
          : {
              collector: "legacy-file-v1",
              scanned_files: value.observations.length,
              reused_files: 0,
              parsed_files: 0,
              parser_skipped_paths: [],
              parser_failed_paths: []
            },
      delta: {
        previous_commit: legacyDelta.previous_commit,
        added_paths: legacyDelta.added_paths,
        changed_paths: legacyDelta.changed_paths,
        deleted_paths: legacyDelta.deleted_paths,
        unchanged_paths: legacyDelta.unchanged_paths,
        added_symbol_ids: legacyDelta.added_symbol_ids,
        changed_symbol_ids: legacyDelta.changed_symbol_ids,
        deleted_symbol_ids: legacyDelta.deleted_symbol_ids,
        added_dependency_edge_ids: legacyDelta.added_dependency_edge_ids,
        deleted_dependency_edge_ids: legacyDelta.deleted_dependency_edge_ids
      },
      invalidated_claim_ids: Array.isArray(value.invalidated_claim_ids) ? value.invalidated_claim_ids : [],
      selection_sources: REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES
    };
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
    (claim.schema_version !== 1 && claim.schema_version !== 2) ||
    claim.claim_id !== record.id ||
    typeof claim.repo_id !== "string" ||
    typeof claim.statement !== "string" ||
    !Array.isArray(claim.evidence) ||
    !Array.isArray(claim.tags) ||
    (claim.status !== "active" && claim.status !== "stale")
  )
    return undefined;
  const evidence = claim.evidence.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.observation_id !== "string" ||
      typeof item.path !== "string" ||
      typeof item.digest !== "string"
    ) {
      return [];
    }
    const kind = item.kind === "symbol" ? "symbol" : "file";
    if (kind === "symbol" && (typeof item.symbol_id !== "string" || typeof item.qualified_name !== "string")) {
      return [];
    }
    return [{ ...item, kind } as RepoAtlasClaimEvidence];
  });
  if (evidence.length !== claim.evidence.length) return undefined;
  return { ...claim, evidence };
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

function atlasDelta(
  previous: RepoAtlasSnapshot | undefined,
  observations: RepoAtlasObservation[],
  symbols: RepoAtlasSymbolObservation[],
  dependencyEdges: RepoAtlasDependencyEdge[]
): RepoAtlasDelta {
  const before = previous?.observations_by_path ?? {};
  const after = Object.fromEntries(observations.map((observation) => [observation.path, observation]));
  const addedPaths = observations
    .filter((observation) => before[observation.path] === undefined)
    .map(({ path }) => path);
  const changedPaths = observations
    .filter((observation) => before[observation.path] && before[observation.path]!.digest !== observation.digest)
    .map(({ path }) => path);
  const deletedPaths = Object.keys(before).filter((path) => after[path] === undefined);
  const beforeSymbols = previous?.symbols_by_id ?? {};
  const afterSymbols = Object.fromEntries(symbols.map((symbol) => [symbol.symbol_id, symbol]));
  const addedSymbolIds = symbols.filter((symbol) => !beforeSymbols[symbol.symbol_id]).map((symbol) => symbol.symbol_id);
  const changedSymbolIds = symbols
    .filter(
      (symbol) =>
        beforeSymbols[symbol.symbol_id]?.digest !== undefined &&
        beforeSymbols[symbol.symbol_id]!.digest !== symbol.digest
    )
    .map((symbol) => symbol.symbol_id);
  const deletedSymbolIds = Object.keys(beforeSymbols).filter((symbolId) => !afterSymbols[symbolId]);
  const beforeEdges = new Set((previous?.dependency_edges ?? []).map((edge) => edge.edge_id));
  const afterEdges = new Set(dependencyEdges.map((edge) => edge.edge_id));
  return {
    ...(previous ? { previous_commit: previous.head_commit } : {}),
    added_paths: addedPaths.sort(),
    changed_paths: changedPaths.sort(),
    deleted_paths: deletedPaths.sort(),
    unchanged_paths: observations.length - addedPaths.length - changedPaths.length,
    added_symbol_ids: addedSymbolIds.sort(),
    changed_symbol_ids: changedSymbolIds.sort(),
    deleted_symbol_ids: deletedSymbolIds.sort(),
    added_dependency_edge_ids: [...afterEdges].filter((edgeId) => !beforeEdges.has(edgeId)).sort(),
    deleted_dependency_edge_ids: [...beforeEdges].filter((edgeId) => !afterEdges.has(edgeId)).sort()
  };
}

async function invalidateClaims(
  storePath: string,
  repoId: string,
  headCommit: string,
  workspaceDigest: string,
  observationsByPath: Record<string, RepoAtlasObservation>,
  symbolsById: Record<string, RepoAtlasSymbolObservation>,
  createdAt: string
): Promise<string[]> {
  const invalidated: string[] = [];
  const deviceId = (await readStoreConfig(storePath)).device_id;
  for (const { record, claim } of await repoClaims(storePath, repoId)) {
    if (claim.status !== "active") continue;
    const invalidatedEvidence = claim.evidence.filter((evidence) =>
      evidence.kind === "symbol"
        ? !evidence.symbol_id || symbolsById[evidence.symbol_id]?.digest !== evidence.digest
        : observationsByPath[evidence.path]?.digest !== evidence.digest
    );
    const invalidatedPaths = invalidatedEvidence
      .map((evidence) => evidence.path)
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort();
    const invalidatedSymbolIds = invalidatedEvidence
      .flatMap((evidence) => (evidence.kind === "symbol" && evidence.symbol_id ? [evidence.symbol_id] : []))
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
          paths: invalidatedPaths,
          ...(invalidatedSymbolIds.length ? { symbol_ids: invalidatedSymbolIds } : {})
        }
      },
      reason: "Repo Atlas evidence changed or disappeared.",
      created_at: createdAt,
      source: { client: "moryn.repo-atlas", device_id: deviceId }
    };
    const appended = await appendEventIfAbsent(storePath, event);
    if (appended.created) invalidated.push(record.id);
  }
  if (invalidated.length > 0) await rebuildDerivedViews(storePath);
  return invalidated.sort();
}

function nulSeparatedPaths(value: string): string[] {
  return value.split("\u0000").filter(Boolean).map(safeTrackedPath);
}

async function workingTreeChangedPaths(root: string): Promise<string[]> {
  const [unstaged, staged] = await Promise.all([
    git(root, ["diff", "--name-only", "-z", "HEAD", "--"]),
    git(root, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"])
  ]);
  return [...new Set([...nulSeparatedPaths(unstaged), ...nulSeparatedPaths(staged)])].sort();
}

async function pathsToRescan(
  root: string,
  tracked: string[],
  headCommit: string,
  previous: RepoAtlasSnapshot | undefined,
  dirtyPaths: string[]
): Promise<Set<string>> {
  if (previous?.scan.collector !== "repo-atlas-v2") return new Set(tracked);
  const trackedSet = new Set(tracked);
  const changed = new Set<string>([
    ...dirtyPaths,
    ...previous.dirty_paths,
    ...tracked.filter((path) => !previous.observations_by_path[path])
  ]);
  if (previous.head_commit !== headCommit) {
    try {
      for (const path of nulSeparatedPaths(
        await git(root, ["diff", "--name-only", "-z", previous.head_commit, headCommit, "--"])
      )) {
        changed.add(path);
      }
    } catch {
      return new Set(tracked);
    }
  }
  const previousPaths = new Set(previous.observations.map((observation) => observation.path));
  const topologyChanged =
    tracked.some((path) => !previousPaths.has(path)) || [...previousPaths].some((path) => !trackedSet.has(path));
  if (topologyChanged) {
    for (const path of tracked) if (supportedParserPath(path)) changed.add(path);
  }
  return new Set([...changed].filter((path) => trackedSet.has(path)));
}

export async function scanRepoAtlas(input: ScanRepoAtlasInput): Promise<RepoAtlasSnapshot> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const maxFiles = boundedMaxFiles(input.max_files);
  const generatedAt = (input.now ?? (() => new Date().toISOString()))();
  const { root, repo_id: repoId } = await repositoryIdentity(repoPath);
  const indexedPaths = nulSeparatedPaths(await git(root, ["ls-files", "-z"]));
  const deletedPaths = new Set(nulSeparatedPaths(await git(root, ["ls-files", "--deleted", "-z"])));
  const tracked = indexedPaths.filter((path) => !deletedPaths.has(path)).sort();
  if (tracked.length > maxFiles) {
    throw new Error(`Repo Atlas file limit exceeded: ${tracked.length} tracked files is greater than ${maxFiles}`);
  }
  const headCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const previous = await readSnapshotById(storePath, repoId);
  const dirtyPaths = await workingTreeChangedPaths(root);
  const rescanPaths = await pathsToRescan(root, tracked, headCommit, previous, dirtyPaths);
  const trackedSet = new Set(tracked);
  const previousSymbolsByPath = new Map<string, RepoAtlasSymbolObservation[]>();
  const previousEdgesByPath = new Map<string, RepoAtlasDependencyEdge[]>();
  for (const symbol of previous?.symbols ?? []) {
    previousSymbolsByPath.set(symbol.path, [...(previousSymbolsByPath.get(symbol.path) ?? []), symbol]);
  }
  for (const edge of previous?.dependency_edges ?? []) {
    previousEdgesByPath.set(edge.from_path, [...(previousEdgesByPath.get(edge.from_path) ?? []), edge]);
  }
  const observations: RepoAtlasObservation[] = [];
  const symbols: RepoAtlasSymbolObservation[] = [];
  const dependencyEdges: RepoAtlasDependencyEdge[] = [];
  const parserSkippedPaths: string[] = [];
  const parserFailedPaths: string[] = [];
  let scannedFiles = 0;
  let reusedFiles = 0;
  let parsedFiles = 0;
  for (const path of tracked) {
    const reusable = !rescanPaths.has(path) ? previous?.observations_by_path[path] : undefined;
    if (reusable) {
      observations.push(reusable);
      symbols.push(...(previousSymbolsByPath.get(path) ?? []));
      dependencyEdges.push(...(previousEdgesByPath.get(path) ?? []));
      reusedFiles += 1;
      continue;
    }
    const observation = await observeFile(root, path, repoId);
    const analysis = await analyzeSource(root, path, observation, repoId, trackedSet);
    observations.push(observation);
    symbols.push(...analysis.symbols);
    dependencyEdges.push(...analysis.dependency_edges);
    scannedFiles += 1;
    if (analysis.parsed) parsedFiles += 1;
    if (analysis.skipped) parserSkippedPaths.push(path);
    if (analysis.failed) parserFailedPaths.push(path);
  }
  const observationsByPath = Object.fromEntries(observations.map((observation) => [observation.path, observation]));
  symbols.sort((left, right) => left.path.localeCompare(right.path) || left.start_line - right.start_line);
  dependencyEdges.sort((left, right) => left.edge_id.localeCompare(right.edge_id));
  const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.symbol_id, symbol]));
  const branch = (await optionalGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])) ?? "detached";
  const workspaceDigest = sha256(
    stableJson({
      schema_version: REPO_ATLAS_SCHEMA_VERSION,
      observations: observations.map((observation) => observation.observation_id).sort(),
      symbols: symbols.map((symbol) => `${symbol.symbol_id}:${symbol.digest}`).sort(),
      dependency_edges: dependencyEdges.map((edge) => edge.edge_id).sort()
    })
  );
  let snapshot: RepoAtlasSnapshot = {
    schema_version: REPO_ATLAS_SCHEMA_VERSION,
    repo_id: repoId,
    head_commit: headCommit,
    branch,
    dirty: dirtyPaths.length > 0,
    workspace_digest: workspaceDigest,
    generated_at: generatedAt,
    observations,
    observations_by_path: observationsByPath,
    symbols,
    symbols_by_id: symbolsById,
    dependency_edges: dependencyEdges,
    dirty_paths: dirtyPaths,
    scan: {
      collector: "repo-atlas-v2",
      scanned_files: scannedFiles,
      reused_files: reusedFiles,
      parsed_files: parsedFiles,
      parser_skipped_paths: parserSkippedPaths.sort(),
      parser_failed_paths: parserFailedPaths.sort()
    },
    delta: atlasDelta(previous, observations, symbols, dependencyEdges),
    invalidated_claim_ids: [],
    selection_sources: REPO_ATLAS_SNAPSHOT_SELECTION_SOURCES
  };
  await writeSnapshot(storePath, snapshot);
  const invalidatedClaimIds = await invalidateClaims(
    storePath,
    repoId,
    headCommit,
    workspaceDigest,
    observationsByPath,
    symbolsById,
    generatedAt
  );
  if (invalidatedClaimIds.length > 0) {
    snapshot = { ...snapshot, invalidated_claim_ids: invalidatedClaimIds };
    await writeSnapshot(storePath, snapshot);
  }
  return snapshot;
}

function normalizeStringArray(value: string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid argument: ${name} must contain non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function symbolReference(value: string): { path: string; qualified_name: string } {
  const separator = value.lastIndexOf("#");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Invalid argument: evidence_symbols must use <tracked_path>#<qualified_name>");
  }
  return {
    path: safeTrackedPath(value.slice(0, separator)),
    qualified_name: nonEmptyString(value.slice(separator + 1), "evidence symbol qualified_name")
  };
}

function fileEvidence(snapshot: RepoAtlasSnapshot, path: string): RepoAtlasClaimEvidence {
  const observation = snapshot.observations_by_path[path];
  if (!observation) throw new Error(`Repo Atlas evidence path not found: ${path}`);
  return {
    kind: "file",
    observation_id: observation.observation_id,
    path,
    digest: observation.digest
  };
}

function symbolEvidence(snapshot: RepoAtlasSnapshot, reference: string): RepoAtlasClaimEvidence {
  const requested = symbolReference(reference);
  const matches = snapshot.symbols.filter(
    (symbol) => symbol.path === requested.path && symbol.qualified_name === requested.qualified_name
  );
  if (matches.length === 0) throw new Error(`Repo Atlas evidence symbol not found: ${reference}`);
  if (matches.length > 1) throw new Error(`Repo Atlas evidence symbol is ambiguous: ${reference}`);
  const symbol = matches[0]!;
  const observation = snapshot.observations_by_path[symbol.path];
  if (!observation) throw new Error(`Repo Atlas symbol file observation not found: ${symbol.path}`);
  return {
    kind: "symbol",
    observation_id: observation.observation_id,
    path: symbol.path,
    digest: symbol.digest,
    symbol_id: symbol.symbol_id,
    qualified_name: symbol.qualified_name
  };
}

function currentClaimEvidence(
  snapshot: RepoAtlasSnapshot,
  evidence: RepoAtlasClaimEvidence[]
): RepoAtlasClaimEvidence[] {
  return evidence.map((item) => {
    if (item.kind === "file") return fileEvidence(snapshot, item.path);
    if (!item.symbol_id) throw new Error(`Repo Atlas claim symbol identity is missing: ${item.path}`);
    const symbol = snapshot.symbols_by_id[item.symbol_id];
    if (!symbol) {
      throw new Error(`Repo Atlas claim symbol no longer exists: ${item.path}#${item.qualified_name ?? "unknown"}`);
    }
    const observation = snapshot.observations_by_path[symbol.path];
    if (!observation) throw new Error(`Repo Atlas symbol file observation not found: ${symbol.path}`);
    return {
      kind: "symbol",
      observation_id: observation.observation_id,
      path: symbol.path,
      digest: symbol.digest,
      symbol_id: symbol.symbol_id,
      qualified_name: symbol.qualified_name
    };
  });
}

export async function addRepoAtlasClaim(input: AddRepoAtlasClaimInput): Promise<AddRepoAtlasClaimResult> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const projectId = nonEmptyString(input.project_id, "project_id");
  const statement = nonEmptyString(input.statement, "statement");
  const evidencePaths = normalizeStringArray(input.evidence_paths, "evidence_paths");
  const evidenceSymbols = normalizeStringArray(input.evidence_symbols, "evidence_symbols");
  if (evidencePaths.length === 0 && evidenceSymbols.length === 0) {
    throw new Error("Invalid argument: at least one evidence path or symbol is required");
  }
  const confidence = input.confidence ?? 0.7;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Invalid argument: confidence must be between 0 and 1");
  }
  const distribution = input.distribution ?? "personal_sync";
  if (!REPO_ATLAS_DISTRIBUTIONS.includes(distribution)) throw new Error("Invalid argument: distribution");
  const { repo_id: repoId } = await repositoryIdentity(repoPath);
  const source = {
    ...input.source,
    device_id: input.source.device_id ?? (await readStoreConfig(storePath)).device_id
  };
  const snapshot = await readSnapshotById(storePath, repoId);
  if (!snapshot) throw new Error("Repo Atlas has not been scanned; run a scan before adding claims");
  const evidence = [
    ...evidencePaths.map((path) => fileEvidence(snapshot, path)),
    ...evidenceSymbols.map((reference) => symbolEvidence(snapshot, reference))
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.qualified_name ?? "").localeCompare(right.qualified_name ?? "") ||
      left.kind.localeCompare(right.kind)
  );
  const tags = normalizeStringArray(input.tags, "tags");
  const claimDigest = sha256(stableJson({ repoId, statement, evidence, tags }));
  const claimId = `rec_repo_atlas_claim_${claimDigest.slice(0, 32)}`;
  const claim: RepoAtlasClaim = {
    schema_version: 2,
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
    source,
    provenance: { method: source.client === "user" ? "user-confirmed" : "agent-proposed" }
  };
  const event: MorynEvent = {
    event_id: `evt_repo_atlas_claim_${claimDigest.slice(0, 32)}`,
    op: "upsert_record",
    record,
    created_at: createdAt,
    source
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

export async function reverifyRepoAtlasClaim(
  input: ReverifyRepoAtlasClaimInput
): Promise<ReverifyRepoAtlasClaimResult> {
  const storePath = nonEmptyString(input.store_path, "store_path");
  const repoPath = nonEmptyString(input.repo_path, "repo_path");
  const claimId = nonEmptyString(input.claim_id, "claim_id");
  const { repo_id: repoId } = await repositoryIdentity(repoPath);
  const snapshot = await readSnapshotById(storePath, repoId);
  if (!snapshot) throw new Error("Repo Atlas has not been scanned; run a scan before re-verifying claims");
  const existing = (await repoClaims(storePath, repoId)).find(({ claim }) => claim.claim_id === claimId);
  if (!existing) throw new Error(`Repo Atlas claim not found: ${claimId}`);
  const claim: RepoAtlasClaim = {
    ...existing.claim,
    schema_version: 2,
    evidence: currentClaimEvidence(snapshot, existing.claim.evidence),
    status: "active",
    verified: { commit: snapshot.head_commit, workspace_digest: snapshot.workspace_digest }
  };
  delete claim.invalidated;
  const identity = { repoId, claimId, workspaceDigest: snapshot.workspace_digest, evidence: claim.evidence };
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const source = {
    ...input.source,
    device_id: input.source.device_id ?? (await readStoreConfig(storePath)).device_id
  };
  const event: MorynEvent = {
    event_id: `evt_repo_atlas_reverify_${sha256(stableJson(identity)).slice(0, 32)}`,
    op: "revise_record",
    record_id: claimId,
    patch: { "content.repo_atlas_claim": claim },
    reason: "Repo Atlas claim evidence was explicitly re-verified.",
    created_at: createdAt,
    source
  };
  const appended = await appendEventIfAbsent(storePath, event);
  if (appended.created) await rebuildDerivedViews(storePath);
  const record = (await readCurrentRecords(storePath)).records.find((candidate) => candidate.id === claimId);
  const persisted = record ? claimFromRecord(record) : undefined;
  if (!record || !persisted) throw new Error("Repo Atlas re-verified claim could not be read back");
  return { claim: persisted, record, revised: appended.created, storage: appended.storage };
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

function symbolScore(symbol: RepoAtlasSymbolObservation, lens: RepoAtlasLens, tokens: string[]): number {
  const searchable = `${symbol.path} ${symbol.name} ${symbol.qualified_name} ${symbol.kind}`.toLowerCase();
  const tokenScore = tokens.reduce((score, token) => score + (searchable.includes(token) ? 4 : 0), 0);
  return tokenScore + (symbol.exported ? 3 : 0) + (lens === "onboarding" && symbol.kind === "class" ? 2 : 0);
}

function dependencyScore(edge: RepoAtlasDependencyEdge, tokens: string[]): number {
  const searchable = `${edge.from_path} ${edge.specifier} ${edge.resolved_path ?? ""}`.toLowerCase();
  return tokens.reduce((score, token) => score + (searchable.includes(token) ? 4 : 0), edge.external ? 0 : 1);
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
  const impactSymbols = new Set([
    ...snapshot.delta.added_symbol_ids,
    ...snapshot.delta.changed_symbol_ids,
    ...snapshot.delta.deleted_symbol_ids
  ]);
  const impactEdges = new Set([
    ...snapshot.delta.added_dependency_edge_ids,
    ...snapshot.delta.deleted_dependency_edge_ids
  ]);
  const observations = snapshot.observations
    .filter((observation) => input.lens !== "release_impact" || impactPaths.has(observation.path))
    .map((observation) => ({ observation, score: pathScore(observation, input.lens, tokens) }))
    .filter(({ score }) => input.lens !== "request_path" || tokens.length === 0 || score > 2)
    .sort((left, right) => right.score - left.score || left.observation.path.localeCompare(right.observation.path))
    .slice(0, limit)
    .map(({ observation }) => observation);
  const symbols = snapshot.symbols
    .filter((symbol) => input.lens !== "release_impact" || impactSymbols.has(symbol.symbol_id))
    .map((symbol) => ({ symbol, score: symbolScore(symbol, input.lens, tokens) }))
    .filter(({ score }) => input.lens !== "request_path" || tokens.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.symbol.path.localeCompare(right.symbol.path) ||
        left.symbol.start_line - right.symbol.start_line
    )
    .slice(0, limit)
    .map(({ symbol }) => symbol);
  const dependencyEdges = snapshot.dependency_edges
    .filter((edge) => input.lens !== "release_impact" || impactEdges.has(edge.edge_id))
    .map((edge) => ({ edge, score: dependencyScore(edge, tokens) }))
    .filter(({ score }) => input.lens !== "request_path" || tokens.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.edge.edge_id.localeCompare(right.edge.edge_id))
    .slice(0, limit)
    .map(({ edge }) => edge);
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
      roles: counts(snapshot.observations.map(({ role }) => role)),
      symbols: snapshot.symbols.length,
      dependency_edges: snapshot.dependency_edges.length
    },
    paths: observations,
    symbols,
    dependency_edges: dependencyEdges,
    claims: selectedClaims,
    delta: snapshot.delta,
    selection_sources: REPO_ATLAS_VIEW_SELECTION_SOURCES
  };
}
