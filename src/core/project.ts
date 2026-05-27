import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

const syncModeSchema = z.preprocess(
  (value) => value === "auto" ? "interval" : value,
  z.enum(["manual", "session", "interval"])
);

const projectConfigSchema = z.object({
  project_id: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  default_skills: z.array(z.string().min(1)).default([]),
  sync: z.object({
    mode: syncModeSchema.default("session")
  }).default({ mode: "session" })
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
  project_id?: string;
  tags?: string[];
  default_skills?: string[];
  sync?: { mode?: SyncMode };
}

interface ProjectConfigFile {
  config: ProjectConfig;
  directory: string;
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateOptionalString(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateRequiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateOptionalStringArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateInitializeProjectConfigInput(input: unknown): asserts input is InitializeProjectConfigInput {
  assertPlainObject(input, "project config input");
  validateOptionalString(input.project_id, "project_id");
  validateOptionalStringArray(input.tags, "tags");
  validateOptionalStringArray(input.default_skills, "default_skills");

  if (input.sync !== undefined) {
    assertPlainObject(input.sync, "sync");
    if (
      input.sync.mode !== undefined &&
      input.sync.mode !== "manual" &&
      input.sync.mode !== "session" &&
      input.sync.mode !== "interval" &&
      input.sync.mode !== "auto"
    ) {
      throw new Error("Invalid argument: Invalid sync.mode");
    }
  }
}

function validateResolveProjectContextInput(input: unknown): asserts input is { projectPath?: string; projectId?: string } {
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

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    const trimmed = stdout.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function readProjectConfigAt(projectPath: string): Promise<ProjectConfig | undefined> {
  try {
    const rawText = await readFile(resolve(projectPath, ".memora.json"), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid project config: ${message}`);
    }
    const result = projectConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid project config: ${z.prettifyError(result.error)}`);
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

export async function initializeProjectConfig(projectPath: string, input: InitializeProjectConfigInput = {}): Promise<{ config: ProjectConfig; path: string }> {
  validateRequiredString(projectPath, "projectPath");
  validateInitializeProjectConfigInput(input);
  const resolved = resolve(projectPath);
  await mkdir(resolved, { recursive: true });
  const existing = await readProjectConfigAt(resolved);
  const parsed = projectConfigSchema.parse({
    project_id: input.project_id ?? existing?.project_id ?? projectIdFromPath(resolved),
    tags: input.tags ?? existing?.tags ?? [],
    default_skills: input.default_skills ?? existing?.default_skills ?? [],
    sync: {
      mode: input.sync?.mode ?? existing?.sync.mode ?? "session"
    }
  });
  const path = resolve(resolved, ".memora.json");
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { config: parsed, path };
}

export async function resolveProjectContext(input: { projectPath?: string; projectId?: string }): Promise<ProjectContext> {
  validateResolveProjectContextInput(input);
  const projectPath = resolve(input.projectPath ?? process.cwd());
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
    return { project_id: repoId(remote), project_path: projectPath, source: "git_remote", config };
  }

  const root = await git(["rev-parse", "--show-toplevel"], projectPath);
  if (root) {
    return { project_id: repoId(resolve(root)), project_path: projectPath, source: "git_root", config };
  }

  return { project_id: projectIdFromPath(projectPath), project_path: projectPath, source: "directory", config };
}
