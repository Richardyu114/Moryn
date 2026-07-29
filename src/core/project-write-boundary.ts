import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
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

export async function hardenProjectBackupDirectory(input: {
  root_path: string;
  relative_path: string;
  backup_name: RegExp;
  description: string;
}): Promise<string | undefined> {
  const probe = await resolveProjectWriteTarget(
    input.root_path,
    join(input.relative_path, ".moryn-permission-probe"),
    input.description
  );
  const directoryPath = dirname(probe.target_path);
  try {
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error(`Invalid ${input.description}: backup path is not a regular directory: ${directoryPath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }

  await chmod(directoryPath, 0o700);
  const ignorePath = join(directoryPath, ".gitignore");
  try {
    const ignore = await lstat(ignorePath);
    if (ignore.isSymbolicLink() || !ignore.isFile()) {
      throw new Error(`Invalid ${input.description}: backup ignore is not a regular file: ${ignorePath}`);
    }
    if ((await readFile(ignorePath, "utf8")) !== "*\n") {
      throw new Error(`Invalid ${input.description}: backup ignore content is not Moryn-owned: ${ignorePath}`);
    }
    await chmod(ignorePath, 0o600);
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(ignorePath, "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(ignorePath, 0o600);
    } else {
      throw error;
    }
  }
  for (const name of await readdir(directoryPath)) {
    if (!input.backup_name.test(name)) continue;
    const backupPath = join(directoryPath, name);
    const backup = await lstat(backupPath);
    if (backup.isSymbolicLink() || !backup.isFile()) {
      throw new Error(`Invalid ${input.description}: backup is not a regular file: ${backupPath}`);
    }
    await chmod(backupPath, 0o600);
  }
  return directoryPath;
}
