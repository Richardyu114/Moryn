import { createHash } from "node:crypto";
import { lstat, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostIntegrationArtifact } from "./host-integration-artifacts.js";
import {
  ensureProjectWriteDirectory,
  ensureProjectWriteParent,
  projectFileExists,
  resolveProjectWriteTarget
} from "./project-write-boundary.js";

export interface CodexHooksMergeResult {
  changed: boolean;
  settings: Record<string, any>;
  changed_events: string[];
  owned_entries_removed: number;
}

export interface CodexActivationResult extends CodexHooksMergeResult {
  created: boolean;
  backup_created: boolean;
  target_path: string;
  backup_path?: string;
  previous_digest?: string;
  new_digest: string;
}

function objectValue(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Codex hooks: ${path} must be an object`);
  return value as Record<string, any>;
}

function entries(value: unknown, event: string): Record<string, any>[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Codex hooks: hooks.${event} must be an array`);
  return value.map((entry, index) => objectValue(entry, `hooks.${event}[${index}]`));
}

function entryCommand(entry: Record<string, any>): string | undefined {
  if (!Array.isArray(entry.hooks)) return undefined;
  const hook = entry.hooks.find(
    (value: unknown) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).command === "string"
  );
  return hook ? (hook as Record<string, string>).command : undefined;
}

function owned(entry: Record<string, any>, activationId: string): boolean {
  return entryCommand(entry)?.split(/\s+/).includes(activationId) === true;
}

export function mergeCodexHooks(
  current: unknown | undefined,
  artifact: HostIntegrationArtifact
): CodexHooksMergeResult {
  if (artifact.host !== "codex" || artifact.format !== "json")
    throw new Error("Invalid Codex hooks: expected a Codex JSON artifact");
  const root = current === undefined ? {} : objectValue(current, "root");
  const currentHooks = root.hooks === undefined ? {} : objectValue(root.hooks, "hooks");
  const generatedHooks = objectValue(
    objectValue(JSON.parse(artifact.content), "generated root").hooks,
    "generated hooks"
  );
  const hooks: Record<string, any> = { ...currentHooks };
  const changedEvents: string[] = [];
  let ownedEntriesRemoved = 0;
  for (const [event, generatedValue] of Object.entries(generatedHooks)) {
    const generatedEntries = entries(generatedValue, event);
    const currentEntries = currentHooks[event] === undefined ? [] : entries(currentHooks[event], event);
    const retained = currentEntries.filter((entry) => {
      const isOwned = owned(entry, artifact.activation_id);
      if (isOwned) ownedEntriesRemoved += 1;
      return !isOwned;
    });
    const merged = [...retained, ...generatedEntries];
    hooks[event] = merged;
    if (JSON.stringify(currentEntries) !== JSON.stringify(merged)) changedEvents.push(event);
  }
  for (const [event, value] of Object.entries(currentHooks)) if (!(event in generatedHooks)) entries(value, event);
  const settings = { ...root, hooks };
  return {
    changed: JSON.stringify(root) !== JSON.stringify(settings),
    settings,
    changed_events: changedEvents,
    owned_entries_removed: ownedEntriesRemoved
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function activateCodexHooks(input: {
  project_path: string;
  artifact: HostIntegrationArtifact;
}): Promise<CodexActivationResult> {
  if (input.artifact.host !== "codex") throw new Error("Invalid Codex hooks: activation requires a Codex artifact");
  if (input.artifact.path !== ".codex/moryn-hooks.json" || input.artifact.merge_target !== ".codex/hooks.json") {
    throw new Error("Invalid Codex hooks: unexpected artifact path or merge target");
  }
  const boundary = await resolveProjectWriteTarget(input.project_path, input.artifact.merge_target, "Codex hooks");
  const targetPath = boundary.target_path;
  let existingText: string | undefined;
  if (await projectFileExists(boundary, "Codex hooks")) {
    existingText = await readFile(targetPath, "utf8");
  }
  let current: unknown | undefined;
  if (existingText !== undefined) {
    try {
      current = JSON.parse(existingText);
    } catch {
      throw new Error(`Invalid Codex hooks JSON: ${targetPath}`);
    }
  }
  const merged = mergeCodexHooks(current, input.artifact);
  const newText = `${JSON.stringify(merged.settings, null, 2)}\n`;
  const newDigest = digest(newText);
  if (!merged.changed && existingText !== undefined)
    return {
      ...merged,
      created: false,
      backup_created: false,
      target_path: targetPath,
      previous_digest: digest(existingText),
      new_digest: newDigest
    };
  await ensureProjectWriteParent(boundary, "Codex hooks");
  let backupPath: string | undefined;
  if (existingText !== undefined) {
    const previousDigest = digest(existingText);
    const backupDir = await ensureProjectWriteDirectory(
      boundary.root_path,
      ".codex/.moryn-backups",
      "Codex hooks backup"
    );
    backupPath = join(backupDir, `hooks.${previousDigest.slice(0, 16)}.json`);
    try {
      const stat = await lstat(backupPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid Codex hooks backup: ${backupPath}`);
      if ((await readFile(backupPath, "utf8")) !== existingText)
        throw new Error(`Invalid Codex hooks backup content: ${backupPath}`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        await writeFile(backupPath, existingText, { encoding: "utf8", flag: "wx" });
      else throw error;
    }
  }
  const temporaryPath = join(dirname(targetPath), `.hooks.moryn-${process.pid}-${newDigest.slice(0, 12)}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(newText, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, targetPath);
  return {
    ...merged,
    created: existingText === undefined,
    backup_created: existingText !== undefined,
    target_path: targetPath,
    ...(backupPath ? { backup_path: backupPath, previous_digest: digest(existingText!) } : {}),
    new_digest: newDigest
  };
}
