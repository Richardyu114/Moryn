import { createHash } from "node:crypto";
import { chmod, lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { type HostIntegrationArtifact, isPathInsideGitWorktree } from "./host-integration-artifacts.js";
import { ensureProjectWriteDirectory, resolveProjectWriteTarget } from "./project-write-boundary.js";

export interface HostConfigBackupStorage {
  root_path: string;
  relative_path: string;
  path: string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function resolveHostConfigBackupStorage(input: {
  project_path: string;
  artifact: HostIntegrationArtifact;
  backup_root?: string;
}): Promise<HostConfigBackupStorage> {
  let rootPath: string;
  let relativePath: string;
  if (input.backup_root) {
    const requestedRoot = resolve(input.backup_root);
    if (requestedRoot === parse(requestedRoot).root) {
      throw new Error("Invalid host config backup: backup_root must not be a filesystem root");
    }
    rootPath = await realpath(dirname(requestedRoot));
    relativePath = basename(requestedRoot);
  } else if (input.artifact.runtime_binding) {
    rootPath = input.artifact.runtime_binding.root_path;
    relativePath = join(dirname(input.artifact.runtime_binding.relative_path), "host-config-backups");
  } else {
    const projectPath = await realpath(resolve(input.project_path));
    const scope = createHash("sha256")
      .update(JSON.stringify([projectPath, input.artifact.host]), "utf8")
      .digest("hex")
      .slice(0, 32);
    const userKey =
      typeof process.getuid === "function"
        ? String(process.getuid())
        : createHash("sha256").update(homedir(), "utf8").digest("hex").slice(0, 16);
    const directoryName = `.moryn-host-config-backups-${userKey}`;
    const homeRoot = await realpath(homedir());
    if (!isPathInsideGitWorktree(join(homeRoot, directoryName))) {
      rootPath = homeRoot;
      relativePath = join(directoryName, scope);
    } else {
      rootPath = await realpath(tmpdir());
      relativePath = join(directoryName, scope);
    }
  }

  const path = resolve(rootPath, relativePath);
  if (!isAbsolute(path) || path === parse(path).root || isPathInsideGitWorktree(path)) {
    throw new Error("Invalid host config backup: backup directory must be outside Git worktrees");
  }
  return { root_path: rootPath, relative_path: relative(rootPath, path), path };
}

export async function hardenHostConfigBackupStorage(input: {
  storage: HostConfigBackupStorage;
  backup_name: RegExp;
  description: string;
}): Promise<boolean> {
  const probe = await resolveProjectWriteTarget(
    input.storage.root_path,
    join(input.storage.relative_path, ".moryn-permission-probe"),
    input.description
  );
  const directoryPath = dirname(probe.target_path);
  let directory: Awaited<ReturnType<typeof lstat>>;
  try {
    directory = await lstat(directoryPath);
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Invalid ${input.description}: backup path is not a regular directory: ${directoryPath}`);
  }

  await hardenPrivateDirectoryComponents(input.storage.root_path, directoryPath);
  for (const name of await readdir(directoryPath)) {
    if (!input.backup_name.test(name)) continue;
    const backupPath = join(directoryPath, name);
    const backup = await lstat(backupPath);
    if (backup.isSymbolicLink() || !backup.isFile()) {
      throw new Error(`Invalid ${input.description}: backup is not a regular file: ${backupPath}`);
    }
    await chmod(backupPath, 0o600);
  }
  return true;
}

async function ensurePrivateBackupDirectory(storage: HostConfigBackupStorage, description: string): Promise<string> {
  const directoryPath = await ensureProjectWriteDirectory(storage.root_path, storage.relative_path, description);
  await hardenPrivateDirectoryComponents(storage.root_path, directoryPath);
  return directoryPath;
}

async function hardenPrivateDirectoryComponents(rootPath: string, directoryPath: string): Promise<void> {
  const components = relative(rootPath, directoryPath).split(/[\\/]/u).filter(Boolean);
  let current = rootPath;
  for (const component of components) {
    current = join(current, component);
    await chmod(current, 0o700);
  }
}

export async function writeHostConfigBackup(input: {
  storage: HostConfigBackupStorage;
  name: string;
  content: string;
  description: string;
}): Promise<string> {
  if (basename(input.name) !== input.name) throw new Error(`Invalid ${input.description}: backup filename`);
  const directoryPath = await ensurePrivateBackupDirectory(input.storage, input.description);
  const backupPath = join(directoryPath, input.name);
  try {
    const metadata = await lstat(backupPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Invalid ${input.description}: ${backupPath}`);
    }
    if ((await readFile(backupPath, "utf8")) !== input.content) {
      throw new Error(`Invalid ${input.description} content: ${backupPath}`);
    }
    await chmod(backupPath, 0o600);
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(backupPath, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(backupPath, 0o600);
    } else {
      throw error;
    }
  }
  return backupPath;
}
