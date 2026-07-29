import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { execOperationChildProcess, rethrowIfOperationDeadlineExceeded } from "./operation-deadline.js";
import { ensureProjectWriteParent, projectFileExists, resolveProjectWriteTarget } from "./project-write-boundary.js";

export const SYNC_MODES = ["manual", "session", "interval"] as const;
export const PROJECT_SYNC_MODE_INPUTS = [...SYNC_MODES, "auto"] as const;

const syncModeSchema = z.preprocess((value) => (value === "auto" ? "interval" : value), z.enum(SYNC_MODES));
const projectSoulConfigSchema = z.object({
  user_profile_id: z.string().trim().min(1).optional(),
  agent_profile_id: z.string().trim().min(1).optional(),
  char_budget: z.number().int().positive().optional(),
  token_budget: z.number().int().positive().optional()
});

const projectConfigSchema = z.object({
  project_id: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  default_skills: z.array(z.string().min(1)).default([]),
  sync: z
    .object({
      mode: syncModeSchema.default("session")
    })
    .default({ mode: "session" }),
  soul: projectSoulConfigSchema.optional()
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type SyncMode = ProjectConfig["sync"]["mode"];
export type ProjectIdentitySource = "explicit" | "config" | "git_remote" | "git_root" | "directory";

export interface ProjectContext {
  project_id: string;
  project_path: string;
  source: ProjectIdentitySource;
  config?: ProjectConfig;
}

export interface InitializeProjectConfigInput {
  project_id?: unknown;
  tags?: unknown;
  default_skills?: unknown;
  sync?: { mode?: unknown };
  repair?: unknown;
}

type ValidatedInitializeProjectConfigInput = InitializeProjectConfigInput & {
  project_id?: string;
  tags?: string[];
  default_skills?: string[];
  sync?: { mode?: SyncMode };
  repair?: boolean;
};

export const PROJECT_INIT_SELECTION_SOURCES = {
  path: "path",
  config: "config",
  config_file: "artifacts.config",
  project_id: "config.project_id",
  tags: "config.tags",
  default_skills: "config.default_skills",
  sync_mode: "config.sync.mode"
} as const;

export interface InitializeProjectConfigResult {
  config: ProjectConfig;
  path: string;
  artifacts: {
    config: string;
  };
  selection_sources: typeof PROJECT_INIT_SELECTION_SOURCES;
}

interface ProjectConfigFile {
  config: ProjectConfig;
  directory: string;
}

type ProjectArgumentRecoveryHint =
  | {
      rejected_argument: { argument: "project_id" | "projectId" | "projectPath"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { argument: "project_id" | "projectId" | "projectPath"; value_placeholder: string };
    }
  | {
      rejected_argument: { argument: "tags" | "default_skills"; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      retry_with: { argument: "tags" | "default_skills"; value_placeholder: string[] };
    }
  | {
      rejected_argument: { argument: "repair"; value: unknown };
      expected: { kind: "boolean" };
      retry_with: { argument: "repair"; value_placeholder: true };
    }
  | {
      rejected_argument: { argument: "sync.mode"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      retry_with: { argument: "sync.mode"; value_placeholder: "session" };
    }
  | {
      operation_contract: "operations_by_id.project_init";
      rejected_argument: { argument: "path" | "project_id"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<"path" | "project_id", string>;
      retry_with: { argument: "path" | "project_id"; value_placeholder: string };
    }
  | {
      operation_contract: "operations_by_id.project_init";
      rejected_argument: { argument: "tags" | "default_skills"; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      argument_sources: Record<"tags" | "default_skills", string>;
      retry_with: { argument: "tags" | "default_skills"; value_placeholder: string[] };
    }
  | {
      operation_contract: "operations_by_id.project_init";
      rejected_argument: { argument: "repair"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: { repair: string };
      retry_with: { argument: "repair"; value_placeholder: true };
    }
  | {
      operation_contract: "operations_by_id.project_init";
      rejected_argument: { argument: "sync_mode"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { sync_mode: string };
      retry_with: { argument: "sync_mode"; value_placeholder: "session" };
    };

class ProjectArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: ProjectArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: ProjectArgumentRecoveryHint) {
    super(message);
    this.name = "ProjectArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function projectStringAction(name: "project_id" | "projectId" | "projectPath"): string {
  return name === "project_id"
    ? "retry project init with a non-empty project_id"
    : `retry project operation with a non-empty ${name}`;
}

type ProjectInitArgument = "path" | "project_id" | "tags" | "default_skills" | "sync_mode" | "repair";

function projectInitArgumentSource(argument: ProjectInitArgument): string {
  return `operations_by_id.project_init.arguments_by_name.${argument}`;
}

function projectInitRecoveryBase<TArgument extends ProjectInitArgument>(
  argument: TArgument
): {
  operation_contract: "operations_by_id.project_init";
  argument_sources: Record<TArgument, string>;
} {
  return {
    operation_contract: "operations_by_id.project_init",
    argument_sources: {
      [argument]: projectInitArgumentSource(argument)
    } as Record<TArgument, string>
  };
}

function invalidProjectInitStringError(
  argument: "path" | "project_id",
  value: unknown,
  messageName: string = argument
): ProjectArgumentError {
  return new ProjectArgumentError(
    `Invalid argument: Invalid ${messageName}`,
    argument === "path" ? "retry project init with a non-empty path" : "retry project init with a non-empty project_id",
    {
      ...projectInitRecoveryBase(argument),
      rejected_argument: { argument, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { argument, value_placeholder: `<${argument}>` }
    }
  );
}

function invalidProjectStringError(
  name: "project_id" | "projectId" | "projectPath",
  value: unknown,
  source?: "project_init"
): ProjectArgumentError {
  if (source === "project_init") {
    const argument = name === "projectPath" ? "path" : "project_id";
    return invalidProjectInitStringError(argument, value, name);
  }
  return new ProjectArgumentError(`Invalid argument: Invalid ${name}`, projectStringAction(name), {
    rejected_argument: { argument: name, value },
    expected: { kind: "non_empty_string", min_length: 1 },
    retry_with: { argument: name, value_placeholder: `<${name}>` }
  });
}

function invalidProjectStringArrayError(
  name: "tags" | "default_skills",
  value: unknown,
  source?: "project_init"
): ProjectArgumentError {
  const singular = name === "default_skills" ? "default_skill" : "tag";
  if (source === "project_init") {
    return new ProjectArgumentError(
      `Invalid argument: Invalid ${name}`,
      `retry project init with ${name} as non-empty strings`,
      {
        ...projectInitRecoveryBase(name),
        rejected_argument: { argument: name, value },
        expected: { kind: "array_of_non_empty_strings" },
        retry_with: { argument: name, value_placeholder: [`<${singular}>`] }
      }
    );
  }
  return new ProjectArgumentError(
    `Invalid argument: Invalid ${name}`,
    `retry project init with ${name} as non-empty strings`,
    {
      rejected_argument: { argument: name, value },
      expected: { kind: "array_of_non_empty_strings" },
      retry_with: { argument: name, value_placeholder: [`<${singular}>`] }
    }
  );
}

function invalidProjectBooleanError(name: "repair", value: unknown, source?: "project_init"): ProjectArgumentError {
  if (source === "project_init") {
    return new ProjectArgumentError(
      `Invalid argument: Invalid ${name}`,
      "retry project init with a boolean repair value",
      {
        ...projectInitRecoveryBase(name),
        rejected_argument: { argument: name, value },
        expected: { kind: "boolean" },
        retry_with: { argument: name, value_placeholder: true }
      }
    );
  }
  return new ProjectArgumentError(
    `Invalid argument: Invalid ${name}`,
    "retry project init with a boolean repair value",
    {
      rejected_argument: { argument: name, value },
      expected: { kind: "boolean" },
      retry_with: { argument: name, value_placeholder: true }
    }
  );
}

function invalidProjectSyncModeError(value: unknown, source?: "project_init"): ProjectArgumentError {
  if (source === "project_init") {
    return new ProjectArgumentError(
      "Invalid argument: Invalid sync_mode",
      "retry project init with a supported sync_mode",
      {
        ...projectInitRecoveryBase("sync_mode"),
        rejected_argument: { argument: "sync_mode", value },
        expected: { kind: "allowed_values", allowed_values: [...SYNC_MODES, "auto"] },
        retry_with: { argument: "sync_mode", value_placeholder: "session" }
      }
    );
  }
  return new ProjectArgumentError(
    "Invalid argument: Invalid sync.mode",
    "retry project init with a supported sync.mode",
    {
      rejected_argument: { argument: "sync.mode", value },
      expected: { kind: "allowed_values", allowed_values: [...SYNC_MODES, "auto"] },
      retry_with: { argument: "sync.mode", value_placeholder: "session" }
    }
  );
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateOptionalString(
  value: unknown,
  name: "project_id" | "projectId" | "projectPath",
  source?: "project_init"
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidProjectStringError(name, value, source);
  }
}

function validateRequiredString(value: unknown, name: "projectPath", source?: "project_init"): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidProjectStringError(name, value, source);
  }
}

function validateOptionalStringArray(value: unknown, name: "tags" | "default_skills", source?: "project_init"): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw invalidProjectStringArrayError(name, value, source);
  }
}

function validateOptionalBoolean(value: unknown, name: "repair", source?: "project_init"): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw invalidProjectBooleanError(name, value, source);
  }
}

function validateInitializeProjectConfigInput(input: unknown): asserts input is ValidatedInitializeProjectConfigInput {
  assertPlainObject(input, "project config input");
  validateOptionalString(input.project_id, "project_id", "project_init");
  validateOptionalStringArray(input.tags, "tags", "project_init");
  validateOptionalStringArray(input.default_skills, "default_skills", "project_init");
  validateOptionalBoolean(input.repair, "repair", "project_init");

  if (input.sync !== undefined) {
    assertPlainObject(input.sync, "sync");
    if (
      input.sync.mode !== undefined &&
      input.sync.mode !== "manual" &&
      input.sync.mode !== "session" &&
      input.sync.mode !== "interval" &&
      input.sync.mode !== "auto"
    ) {
      throw invalidProjectSyncModeError(input.sync.mode, "project_init");
    }
  }
}

function validateResolveProjectContextInput(
  input: unknown
): asserts input is { projectPath?: string; projectId?: string } {
  assertPlainObject(input, "project context input");
  validateOptionalString(input.projectPath, "projectPath");
  validateOptionalString(input.projectId, "projectId");
}

function hashIdentity(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function projectIdFromPath(projectPath: string): string {
  const resolved = resolve(projectPath);
  const name = basename(resolved) || "project";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function repoId(input: string): string {
  return `repo-${hashIdentity(input)}`;
}

function normalizedRemoteIdentity(remote: string): string {
  const trimmed = remote.trim();
  const normalizeGitHubPath = (path: string) =>
    path
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  const scpLike = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scpLike) {
    return `github.com/${normalizeGitHubPath(scpLike[1])}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "github.com") {
      return `github.com/${normalizeGitHubPath(url.pathname)}`;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execOperationChildProcess("git", args, { cwd });
    const trimmed = stdout.trim();
    return trimmed || undefined;
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    return undefined;
  }
}

async function readProjectConfigAt(projectPath: string): Promise<ProjectConfig | undefined> {
  const configPath = resolve(projectPath, ".moryn.json");
  try {
    const rawText = await readFile(configPath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid project config: ${configPath}: ${message}`);
    }
    const result = projectConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid project config: ${configPath}: ${z.prettifyError(result.error)}`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid project config:")) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function findProjectConfig(projectPath: string): Promise<ProjectConfigFile | undefined> {
  let directory = resolve(projectPath);
  while (true) {
    const config = await readProjectConfigAt(directory);
    if (config) return { config, directory };

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function readProjectConfig(projectPath: string): Promise<ProjectConfig | undefined> {
  validateRequiredString(projectPath, "projectPath");
  return (await findProjectConfig(projectPath))?.config;
}

export async function initializeProjectConfig(
  projectPath: unknown,
  input: InitializeProjectConfigInput = {}
): Promise<InitializeProjectConfigResult> {
  validateRequiredString(projectPath, "projectPath", "project_init");
  validateInitializeProjectConfigInput(input);
  const resolved = resolve(projectPath);
  await mkdir(resolved, { recursive: true });
  const boundary = await resolveProjectWriteTarget(resolved, ".moryn.json", "project config");
  let existing: ProjectConfig | undefined;
  if (await projectFileExists(boundary, "project config")) {
    try {
      existing = await readProjectConfigAt(boundary.root_path);
    } catch (error) {
      if (!input.repair || !(error instanceof Error && error.message.startsWith("Invalid project config:"))) {
        throw error;
      }
      existing = undefined;
    }
  }
  const parsed = projectConfigSchema.parse({
    project_id: input.project_id ?? existing?.project_id ?? projectIdFromPath(resolved),
    tags: input.tags ?? existing?.tags ?? [],
    default_skills: input.default_skills ?? existing?.default_skills ?? [],
    sync: {
      mode: input.sync?.mode ?? existing?.sync.mode ?? "session"
    },
    ...(existing?.soul ? { soul: existing.soul } : {})
  });
  const path = boundary.target_path;
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await ensureProjectWriteParent(boundary, "project config");
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    config: parsed,
    path,
    artifacts: {
      config: ".moryn.json"
    },
    selection_sources: PROJECT_INIT_SELECTION_SOURCES
  };
}

export async function resolveProjectContext(input: {
  projectPath?: string;
  projectId?: string;
}): Promise<ProjectContext> {
  validateResolveProjectContextInput(input);
  const projectPath = resolve(input.projectPath ?? process.cwd());

  if (input.projectId && !input.projectPath) {
    return { project_id: input.projectId, project_path: projectPath, source: "explicit" };
  }

  const configFile = await findProjectConfig(projectPath);
  const config = configFile?.config;
  const resolvedProjectPath = configFile?.directory ?? projectPath;

  if (input.projectId) {
    return { project_id: input.projectId, project_path: resolvedProjectPath, source: "explicit", config };
  }

  if (config?.project_id) {
    return { project_id: config.project_id, project_path: resolvedProjectPath, source: "config", config };
  }

  const remote = await git(["remote", "get-url", "origin"], projectPath);
  if (remote) {
    return {
      project_id: repoId(normalizedRemoteIdentity(remote)),
      project_path: projectPath,
      source: "git_remote",
      config
    };
  }

  const root = await git(["rev-parse", "--show-toplevel"], projectPath);
  if (root) {
    return { project_id: repoId(resolve(root)), project_path: projectPath, source: "git_root", config };
  }

  return { project_id: projectIdFromPath(projectPath), project_path: projectPath, source: "directory", config };
}
