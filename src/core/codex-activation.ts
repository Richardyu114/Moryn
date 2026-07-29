import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  hardenHostConfigBackupStorage,
  resolveHostConfigBackupStorage,
  writeHostConfigBackup
} from "./host-config-backups.js";
import { type HostIntegrationArtifact, isMorynHookOwnedByArtifact } from "./host-integration-artifacts.js";
import {
  ensureProjectWriteParent,
  hardenProjectBackupDirectory,
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

function removeOwnedHandlers(
  entry: Record<string, any>,
  artifact: HostIntegrationArtifact
): { entry?: Record<string, any>; owned: boolean } {
  if (!Array.isArray(entry.hooks)) return { entry, owned: false };
  let owned = false;
  const retained = entry.hooks.filter((hook: unknown) => {
    const command =
      hook &&
      typeof hook === "object" &&
      !Array.isArray(hook) &&
      (hook as Record<string, unknown>).type === "command" &&
      typeof (hook as Record<string, unknown>).command === "string"
        ? ((hook as Record<string, unknown>).command as string)
        : undefined;
    const remove = isMorynHookOwnedByArtifact(command, artifact);
    owned ||= remove;
    return !remove;
  });
  if (!owned) return { entry, owned: false };
  return retained.length > 0 ? { entry: { ...entry, hooks: retained }, owned: true } : { owned: true };
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

  const retainUnownedEntries = (event: string, value: unknown): Record<string, any>[] => {
    const retained: Record<string, any>[] = [];
    for (const entry of entries(value, event)) {
      const result = removeOwnedHandlers(entry, artifact);
      if (result.owned) ownedEntriesRemoved += 1;
      if (result.entry) retained.push(result.entry);
    }
    return retained;
  };

  for (const [event, generatedValue] of Object.entries(generatedHooks)) {
    const generatedEntries = entries(generatedValue, event);
    const currentEntries = currentHooks[event] === undefined ? [] : entries(currentHooks[event], event);
    const retained = retainUnownedEntries(event, currentEntries);
    const merged = [...retained, ...generatedEntries];
    hooks[event] = merged;
    if (JSON.stringify(currentEntries) !== JSON.stringify(merged)) changedEvents.push(event);
  }
  for (const [event, value] of Object.entries(currentHooks)) {
    if (event in generatedHooks) continue;
    const currentEntries = entries(value, event);
    const retained = retainUnownedEntries(event, currentEntries);
    hooks[event] = retained;
    if (JSON.stringify(currentEntries) !== JSON.stringify(retained)) changedEvents.push(event);
  }
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
  backup_root?: string;
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
  await hardenProjectBackupDirectory({
    root_path: input.project_path,
    relative_path: ".codex/.moryn-backups",
    backup_name: /^hooks\.[a-f0-9]{16}\.json$/u,
    description: "Codex hooks backup"
  });
  const backupStorage = await resolveHostConfigBackupStorage(input);
  await hardenHostConfigBackupStorage({
    storage: backupStorage,
    backup_name: /^hooks\.[a-f0-9]{16}\.json$/u,
    description: "Codex hooks backup"
  });
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
    backupPath = await writeHostConfigBackup({
      storage: backupStorage,
      name: `hooks.${previousDigest.slice(0, 16)}.json`,
      content: existingText,
      description: "Codex hooks backup"
    });
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
