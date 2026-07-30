import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, win32 } from "node:path";
import { normalizeHostId } from "./host-adapter-registry.js";
import { HOST_HOOK_TIMEOUT_SECONDS } from "./host-hook-timing.js";
import {
  ensureProjectWriteDirectory,
  ensureProjectWriteParent,
  projectFileExists,
  resolveProjectWriteTarget
} from "./project-write-boundary.js";

const HOST_RUNTIME_LAUNCHER = "/bin/sh";
const HOST_NODE_FALLBACKS = ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"] as const;

export interface HostIntegrationArtifact {
  host: "codex" | "claude";
  path: string;
  format: "toml" | "json";
  content: string;
  merge_target: string;
  merge_instruction: string;
  activation_id: string;
  command: string;
  command_digest: string;
  expected_events: string[];
  runtime_binding?: HostRuntimeBinding;
}

export interface HostRuntimeDescriptor {
  exec_file: string;
  exec_args?: string[];
  cli_entry: string;
  package_version?: string;
  fallback_exec_files?: string[];
  platform?: NodeJS.Platform;
  runtime_binding_root?: string;
}

export interface HostRuntimeBinding {
  path: string;
  root_path: string;
  relative_path: string;
  content: string;
  digest: string;
  unavailable_marker_path: string;
}

export interface HostRuntimeBindingWriteResult {
  created: boolean;
  updated: boolean;
  path: string;
  digest: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseStaticShellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (character === "\n" || character === "\r") return undefined;
    if (character === " " || character === "\t") {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') return undefined;
    if (character === "\\") {
      const escaped = command[index + 1];
      if (escaped === undefined || escaped === "\n" || escaped === "\r") return undefined;
      word += escaped;
      started = true;
      index += 1;
      continue;
    }
    if (";&|<>()$`#*?[]{}~".includes(character)) return undefined;
    word += character;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function isOfficialActivationId(value: string | undefined, host: "codex" | "claude"): boolean {
  return new RegExp(`^(?:moryn-v03-[a-z0-9-]+|moryn-v04-[a-z0-9-]+-[a-f0-9]{32})-${host}$`, "u").test(value ?? "");
}

function isMorynRuntimePrefix(words: readonly string[], artifact: HostIntegrationArtifact): boolean {
  if (words.length === 1) return words[0] === "moryn";
  if (
    words.length === 2 &&
    words[0] === HOST_RUNTIME_LAUNCHER &&
    (isAbsolute(words[1]!) || win32.isAbsolute(words[1]!)) &&
    words[1]!.endsWith(".sh") &&
    isOfficialActivationId(basename(words[1]!, ".sh"), artifact.host)
  )
    return true;
  const executable = words[0];
  const cliEntry = words.at(-1);
  if (
    !executable ||
    !cliEntry ||
    (!isAbsolute(executable) && !win32.isAbsolute(executable)) ||
    (!isAbsolute(cliEntry) && !win32.isAbsolute(cliEntry))
  )
    return false;
  const normalizedCliEntry = cliEntry.replaceAll("\\", "/");
  const executableName = (isAbsolute(executable) ? basename(executable) : win32.basename(executable)).toLowerCase();
  return executableName.startsWith("node") && /\/(?:dist\/cli\.js|src\/cli\.ts)$/u.test(normalizedCliEntry);
}

/**
 * Recognizes the exact static command grammar emitted by current and v0.3
 * official hooks. A project-local host file supports one official Moryn
 * lifecycle integration; retaining an older or mis-scoped identity would run
 * both hooks in parallel. Compound/dynamic shell commands are never claimed.
 */
export function isMorynHookOwnedByArtifact(command: string | undefined, artifact: HostIntegrationArtifact): boolean {
  if (!command) return false;
  const digestMarker = " --command-digest ";
  const digestIndex = command.lastIndexOf(digestMarker);
  if (digestIndex <= 0) return false;
  const commandBase = command.slice(0, digestIndex);
  const declaredDigest = command.slice(digestIndex + digestMarker.length);
  if (!/^[a-f0-9]{64}$/u.test(declaredDigest)) return false;
  if (createHash("sha256").update(commandBase).digest("hex") !== declaredDigest) return false;
  const words = parseStaticShellWords(command);
  if (!words) return false;
  const hostIndex = words.findIndex((word, index) => word === "host" && words[index + 1] === "hook");
  if (hostIndex < 3 || words[hostIndex - 2] !== "--store" || !words[hostIndex - 1]) return false;
  if (!isMorynRuntimePrefix(words.slice(0, hostIndex - 2), artifact)) return false;
  const suffix = words.slice(hostIndex);
  if (
    suffix.length !== 11 ||
    suffix[2] !== "--host" ||
    suffix[3] !== artifact.host ||
    suffix[4] !== "--project" ||
    !suffix[5] ||
    suffix[6] !== "--activation-id" ||
    suffix[8] !== "--host-output" ||
    suffix[9] !== "--command-digest" ||
    suffix[10] !== declaredDigest
  )
    return false;
  return isOfficialActivationId(suffix[7], artifact.host);
}

export function activationId(projectId: string, hostInput: string): string {
  const host = normalizeHostId(hostInput);
  if (host !== "codex" && host !== "claude")
    throw new Error(`Invalid argument: official integration unavailable for host: ${hostInput}`);
  const slug = projectId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (!slug) throw new Error("Invalid argument: project_id must contain an alphanumeric character");
  const projectDigest = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 32);
  return `moryn-v04-${slug}-${projectDigest}-${host}`;
}

function canonicalExistingPath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const canonical = realpathSync(current);
      return resolve(canonical, ...suffix);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function gitWorktreeAncestor(path: string): string | undefined {
  let current = canonicalExistingPath(path);
  while (true) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function isPathInsideGitWorktree(path: string): boolean {
  return gitWorktreeAncestor(path) !== undefined;
}

function bindingRootOutsideGitWorktree(initialRoot: string): string | undefined {
  const directoryName = basename(resolve(initialRoot));
  let root = resolve(initialRoot);
  while (true) {
    const worktree = gitWorktreeAncestor(root);
    if (!worktree) return root;
    const parent = dirname(worktree);
    if (parent === worktree || parent === parse(parent).root) return undefined;
    root = join(parent, directoryName);
  }
}

function bindingRootUsable(root: string): boolean {
  try {
    const metadata = lstatSync(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return false;
    if ((metadata.mode & 0o022) !== 0) return false;
    accessSync(root, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
    try {
      accessSync(dirname(root), fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function defaultRuntimeBindingRoot(storePath: string): string {
  const userKey =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : createHash("sha256").update(homedir(), "utf8").digest("hex").slice(0, 16);
  const directoryName = `.moryn-host-runtime-bindings-${userKey}`;
  const storeSibling = bindingRootOutsideGitWorktree(join(dirname(canonicalExistingPath(storePath)), directoryName));
  if (storeSibling && bindingRootUsable(storeSibling)) return storeSibling;
  const userState = bindingRootOutsideGitWorktree(join(canonicalExistingPath(homedir()), directoryName));
  if (userState && bindingRootUsable(userState)) return userState;
  const systemTemporary = bindingRootOutsideGitWorktree(`/var/tmp/${directoryName}`);
  if (systemTemporary && bindingRootUsable(systemTemporary)) return systemTemporary;
  throw new Error("Invalid host runtime: no runtime binding location exists outside Git worktrees");
}

function runtimeBindingStorage(input: {
  host: "codex" | "claude";
  project_id: string;
  project_path: string;
  store_path: string;
  runtime: HostRuntimeDescriptor;
}): { root_path: string; relative_path: string; path: string } {
  const requestedRoot = canonicalExistingPath(
    input.runtime.runtime_binding_root ?? defaultRuntimeBindingRoot(input.store_path)
  );
  if (requestedRoot === parse(requestedRoot).root) {
    throw new Error("Invalid host runtime: runtime_binding_root must not be a filesystem root");
  }
  if (gitWorktreeAncestor(requestedRoot)) {
    throw new Error("Invalid host runtime: runtime_binding_root must be outside Git worktrees");
  }
  const rootPath = canonicalExistingPath(dirname(requestedRoot));
  const bindingDirectory = join(rootPath, basename(requestedRoot));
  if (gitWorktreeAncestor(bindingDirectory)) {
    throw new Error("Invalid host runtime: canonical runtime_binding_root must be outside Git worktrees");
  }
  const projectPath = canonicalExistingPath(input.project_path);
  const storePath = canonicalExistingPath(input.store_path);
  const scopeDigest = createHash("sha256")
    .update(JSON.stringify([input.project_id, projectPath, storePath, input.host]), "utf8")
    .digest("hex")
    .slice(0, 32);
  const path = join(bindingDirectory, scopeDigest, `${activationId(input.project_id, input.host)}.sh`);
  return { root_path: rootPath, relative_path: relative(rootPath, path), path };
}

function assertAbsoluteRuntimePath(value: string, field: "exec_file" | "cli_entry"): void {
  if (!value || !isAbsolute(value)) {
    throw new Error(`Invalid host runtime: ${field} must be an absolute path`);
  }
}

function runtimeInvocation(runtime: HostRuntimeDescriptor): string {
  assertAbsoluteRuntimePath(runtime.exec_file, "exec_file");
  assertAbsoluteRuntimePath(runtime.cli_entry, "cli_entry");
  return [runtime.exec_file, ...(runtime.exec_args ?? []), runtime.cli_entry].map(shellQuote).join(" ");
}

function runtimeInvocationWithExecutable(runtime: HostRuntimeDescriptor, executable: string): string {
  assertAbsoluteRuntimePath(executable, "exec_file");
  assertAbsoluteRuntimePath(runtime.cli_entry, "cli_entry");
  return [executable, ...(runtime.exec_args ?? []), runtime.cli_entry].map(shellQuote).join(" ");
}

function runtimeBinding(
  host: "codex" | "claude",
  projectId: string,
  projectPath: string,
  storePath: string,
  runtime: HostRuntimeDescriptor | undefined
): HostRuntimeBinding | undefined {
  if (!runtime || (runtime.platform ?? process.platform) === "win32") return undefined;
  const storage = runtimeBindingStorage({
    host,
    project_id: projectId,
    project_path: projectPath,
    store_path: storePath,
    runtime
  });
  const { path } = storage;
  const unavailableMarkerPath = `${path}.unavailable`;
  const versionDigest = createHash("sha256")
    .update(runtime.package_version ?? "unknown")
    .digest("hex")
    .slice(0, 16);
  const fallbackExecutables = [
    ...new Set([...(runtime.fallback_exec_files ?? HOST_NODE_FALLBACKS), ...HOST_NODE_FALLBACKS])
  ].filter((candidate) => candidate !== runtime.exec_file);
  for (const candidate of fallbackExecutables) assertAbsoluteRuntimePath(candidate, "exec_file");
  const content = [
    "#!/bin/sh",
    "set -u",
    `# moryn-package-version-sha256: ${versionDigest}`,
    `MORYN_RUNTIME_MARKER=${shellQuote(unavailableMarkerPath)}`,
    "moryn_clear_runtime_marker() {",
    '  if [ -e "$MORYN_RUNTIME_MARKER" ]; then /bin/rm -f -- "$MORYN_RUNTIME_MARKER" 2>/dev/null || :; fi',
    "}",
    "moryn_mark_runtime_unavailable() {",
    '  (umask 077; set -C; printf \'%s\\n\' "reason=$1" > "$MORYN_RUNTIME_MARKER") 2>/dev/null || :',
    "}",
    `if [ ! -r ${shellQuote(runtime.cli_entry)} ]; then`,
    "  moryn_mark_runtime_unavailable cli_unavailable",
    "  exit 0",
    "fi",
    `if [ -x ${shellQuote(runtime.exec_file)} ]; then`,
    "  moryn_clear_runtime_marker",
    `  exec ${runtimeInvocation(runtime)} "$@"`,
    "fi",
    ...fallbackExecutables.flatMap((candidate) => [
      `if [ -x ${shellQuote(candidate)} ] && ${runtimeInvocationWithExecutable(runtime, candidate)} --version >/dev/null 2>&1; then`,
      "  moryn_clear_runtime_marker",
      `  exec ${runtimeInvocationWithExecutable(runtime, candidate)} "$@"`,
      "fi"
    ]),
    "moryn_mark_runtime_unavailable node_unavailable",
    "exit 0",
    ""
  ].join("\n");
  return {
    path,
    root_path: storage.root_path,
    relative_path: storage.relative_path,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    unavailable_marker_path: unavailableMarkerPath
  };
}

function hookCommandBase(
  host: "codex" | "claude",
  input: { project_id: string; project_path: string; store_path: string; runtime?: HostRuntimeDescriptor }
): string {
  const binding = runtimeBinding(host, input.project_id, input.project_path, input.store_path, input.runtime);
  const executable = binding
    ? [HOST_RUNTIME_LAUNCHER, binding.path].map(shellQuote).join(" ")
    : input.runtime
      ? runtimeInvocation(input.runtime)
      : "moryn";
  return `${executable} --store ${shellQuote(input.store_path)} host hook --host ${host} --project ${shellQuote(input.project_path)} --activation-id ${activationId(input.project_id, host)} --host-output`;
}

function claudeHook(command: string) {
  return [{ matcher: "", hooks: [{ type: "command", command, timeout: HOST_HOOK_TIMEOUT_SECONDS }] }];
}

function codexHook(command: string) {
  return [
    {
      hooks: [{ type: "command", command, timeout: HOST_HOOK_TIMEOUT_SECONDS, statusMessage: "Syncing Moryn context" }]
    }
  ];
}

export function buildHostIntegrationArtifact(input: {
  host: string;
  project_id: string;
  project_path: string;
  store_path: string;
  runtime?: HostRuntimeDescriptor;
}): HostIntegrationArtifact {
  const host = normalizeHostId(input.host);
  if (host !== "codex" && host !== "claude")
    throw new Error(`Invalid argument: official integration unavailable for host: ${input.host}`);
  const normalizedInput = {
    ...input,
    project_path: resolve(input.project_path),
    store_path: resolve(input.store_path)
  };
  const binding = runtimeBinding(
    host,
    input.project_id,
    normalizedInput.project_path,
    normalizedInput.store_path,
    input.runtime
  );
  const commandBase = hookCommandBase(host, normalizedInput);
  const activation_id = activationId(input.project_id, host);
  const command_digest = createHash("sha256").update(commandBase).digest("hex");
  const command = `${commandBase} --command-digest ${command_digest}`;
  if (host === "claude") {
    const expected_events = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop", "SessionEnd"];
    const content = `${JSON.stringify(
      {
        hooks: {
          SessionStart: claudeHook(command),
          UserPromptSubmit: claudeHook(command),
          PreCompact: claudeHook(command),
          PostCompact: claudeHook(command),
          Stop: claudeHook(command),
          SessionEnd: claudeHook(command)
        }
      },
      null,
      2
    )}\n`;
    return {
      host,
      path: ".claude/moryn-settings.json",
      format: "json",
      content,
      merge_target: ".claude/settings.local.json",
      merge_instruction: "Merge the hooks object from .claude/moryn-settings.json into .claude/settings.local.json.",
      activation_id,
      command,
      command_digest,
      expected_events,
      ...(binding ? { runtime_binding: binding } : {})
    };
  }
  const expected_events = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"];
  const content = `${JSON.stringify(
    {
      hooks: {
        SessionStart: codexHook(command),
        UserPromptSubmit: codexHook(command),
        PreCompact: codexHook(command),
        PostCompact: codexHook(command),
        Stop: codexHook(command)
      }
    },
    null,
    2
  )}\n`;
  return {
    host,
    path: ".codex/moryn-hooks.json",
    format: "json",
    content,
    merge_target: ".codex/hooks.json",
    merge_instruction:
      "Merge the hooks object from .codex/moryn-hooks.json into .codex/hooks.json, then review the project hook trust prompt in Codex.",
    activation_id,
    command,
    command_digest,
    expected_events,
    ...(binding ? { runtime_binding: binding } : {})
  };
}

async function writeAtomicProjectFile(input: {
  root_path: string;
  relative_path: string;
  description: string;
  content: string;
  mode?: number;
}): Promise<{ created: boolean; updated: boolean; path: string }> {
  const boundary = await resolveProjectWriteTarget(input.root_path, input.relative_path, input.description);
  const path = boundary.target_path;
  let exists = false;
  let existing: string | undefined;
  if (await projectFileExists(boundary, input.description)) {
    exists = true;
    const currentMode = (await stat(path)).mode & 0o777;
    if (input.mode === undefined || currentMode === input.mode) existing = await readFile(path, "utf8");
  }
  if (existing === input.content) return { created: false, updated: false, path };
  await ensureProjectWriteParent(boundary, input.description);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, input.content, {
      encoding: "utf8",
      flag: "wx",
      ...(input.mode === undefined ? {} : { mode: input.mode })
    });
    if (input.mode !== undefined) await chmod(temporary, input.mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { created: !exists, updated: exists, path };
}

async function ensurePrivateRuntimeBindingDirectory(binding: HostRuntimeBinding): Promise<void> {
  const directoryRelativePath = dirname(binding.relative_path);
  const directoryPath = await ensureProjectWriteDirectory(
    binding.root_path,
    directoryRelativePath,
    `${binding.path} runtime binding directory`
  );
  const components = relative(binding.root_path, directoryPath).split(/[\\/]/u).filter(Boolean);
  let current = binding.root_path;
  for (const component of components) {
    current = join(current, component);
    await chmod(current, 0o700);
  }
}

export class HostIntegrationArtifactPartialCommitError extends Error {
  readonly code = "HOST_INTEGRATION_ARTIFACT_PARTIALLY_COMMITTED";
  readonly committed = true;
  readonly recommended_action = "inspect host integration status before retrying artifact generation";
  readonly recovery_hint: { applied_steps: string[]; applied_paths: string[] };

  constructor(appliedSteps: string[], appliedPaths: string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Host integration artifact partially committed: ${reason}`);
    this.name = "HostIntegrationArtifactPartialCommitError";
    this.recovery_hint = { applied_steps: appliedSteps, applied_paths: appliedPaths };
  }
}

export async function writeHostIntegrationArtifact(input: {
  host: string;
  project_id: string;
  project_path: string;
  store_path: string;
  runtime?: HostRuntimeDescriptor;
}) {
  const artifact = buildHostIntegrationArtifact(input);
  let runtimeBindingWrite: HostRuntimeBindingWriteResult | undefined;
  let unavailableMarkerRemoved = false;
  if (artifact.runtime_binding) {
    await ensurePrivateRuntimeBindingDirectory(artifact.runtime_binding);
    const written = await writeAtomicProjectFile({
      root_path: artifact.runtime_binding.root_path,
      relative_path: artifact.runtime_binding.relative_path,
      description: `${artifact.host} runtime binding`,
      content: artifact.runtime_binding.content,
      mode: 0o700
    });
    const markerBoundary = await resolveProjectWriteTarget(
      artifact.runtime_binding.root_path,
      `${artifact.runtime_binding.relative_path}.unavailable`,
      `${artifact.host} runtime unavailable marker`
    );
    if (await projectFileExists(markerBoundary, `${artifact.host} runtime unavailable marker`)) {
      await rm(markerBoundary.target_path);
      unavailableMarkerRemoved = true;
    }
    runtimeBindingWrite = { ...written, digest: artifact.runtime_binding.digest };
  }
  let written: Awaited<ReturnType<typeof writeAtomicProjectFile>>;
  try {
    written = await writeAtomicProjectFile({
      root_path: input.project_path,
      relative_path: artifact.path,
      description: `${artifact.host} integration`,
      content: artifact.content
    });
  } catch (error) {
    const runtimeBindingChanged = runtimeBindingWrite?.created === true || runtimeBindingWrite?.updated === true;
    if (runtimeBindingChanged || unavailableMarkerRemoved) {
      throw new HostIntegrationArtifactPartialCommitError(
        [
          ...(runtimeBindingChanged ? ["runtime_binding"] : []),
          ...(unavailableMarkerRemoved ? ["runtime_unavailable_marker_removed"] : [])
        ],
        [
          ...(runtimeBindingChanged && artifact.runtime_binding ? [artifact.runtime_binding.path] : []),
          ...(unavailableMarkerRemoved && artifact.runtime_binding
            ? [`${artifact.runtime_binding.path}.unavailable`]
            : [])
        ],
        error
      );
    }
    throw error;
  }
  return {
    ...written,
    artifact,
    ...(runtimeBindingWrite ? { runtime_binding: runtimeBindingWrite } : {})
  };
}
