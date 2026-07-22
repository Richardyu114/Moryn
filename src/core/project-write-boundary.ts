import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProjectWriteTarget {
  root_path: string;
  target_path: string;
  parent_path: string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function assertWithinProject(rootPath: string, candidatePath: string, description: string): void {
  const relation = relative(rootPath, candidatePath);
  if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) return;
  throw new Error(`Invalid ${description}: path escapes the project`);
}

async function inspectDirectoryChain(
  rootPath: string,
  directoryPath: string,
  description: string,
  createMissing: boolean
): Promise<void> {
  assertWithinProject(rootPath, directoryPath, description);
  const relation = relative(rootPath, directoryPath);
  if (!relation) return;

  let current = rootPath;
  for (const component of relation.split(sep)) {
    current = join(current, component);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      if (!createMissing) return;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Invalid ${description}: project write directory is a symbolic link: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Invalid ${description}: project write parent is not a directory: ${current}`);
    }
    assertWithinProject(rootPath, await realpath(current), description);
  }
}

export async function resolveProjectWriteTarget(
  projectPath: string,
  relativePath: string,
  description: string
): Promise<ProjectWriteTarget> {
  const rootPath = await realpath(resolve(projectPath));
  const rootMetadata = await lstat(rootPath);
  if (!rootMetadata.isDirectory()) throw new Error(`Invalid ${description}: project path is not a directory`);
  const targetPath = resolve(rootPath, relativePath);
  assertWithinProject(rootPath, targetPath, description);
  const parentPath = dirname(targetPath);
  await inspectDirectoryChain(rootPath, parentPath, description, false);
  return { root_path: rootPath, target_path: targetPath, parent_path: parentPath };
}

export async function ensureProjectWriteParent(target: ProjectWriteTarget, description: string): Promise<void> {
  await inspectDirectoryChain(target.root_path, target.parent_path, description, true);
}

export async function projectFileExists(target: ProjectWriteTarget, description: string): Promise<boolean> {
  try {
    const metadata = await lstat(target.target_path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Invalid ${description}: target is a symbolic link: ${target.target_path}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`Invalid ${description}: target is not a regular file: ${target.target_path}`);
    }
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

export async function ensureProjectWriteDirectory(
  rootPath: string,
  relativePath: string,
  description: string
): Promise<string> {
  const directoryPath = resolve(rootPath, relativePath);
  await inspectDirectoryChain(rootPath, directoryPath, description, true);
  return directoryPath;
}
