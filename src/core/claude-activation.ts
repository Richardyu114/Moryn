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

export interface ClaudeSettingsMergeResult {
  changed: boolean;
  settings: Record<string, any>;
  changed_events: string[];
  owned_entries_removed: number;
}

export interface ClaudeActivationResult extends ClaudeSettingsMergeResult {
  created: boolean;
  backup_created: boolean;
  target_path: string;
  backup_path?: string;
  previous_digest?: string;
  new_digest: string;
}

function settingsObject(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Claude settings: ${path} must be an object`);
  return value as Record<string, any>;
}

function eventEntries(value: unknown, event: string): Record<string, any>[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Claude settings: hooks.${event} must be an array`);
  return value.map((entry, index) => settingsObject(entry, `hooks.${event}[${index}]`));
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

function semanticJson(value: unknown): string {
  return JSON.stringify(value);
}

export function mergeClaudeSettings(
  current: unknown | undefined,
  artifact: HostIntegrationArtifact
): ClaudeSettingsMergeResult {
  if (artifact.host !== "claude" || artifact.format !== "json")
    throw new Error("Invalid Claude settings: expected a Claude JSON artifact");
  const root = current === undefined ? {} : settingsObject(current, "root");
  const existingHooks = root.hooks === undefined ? {} : settingsObject(root.hooks, "hooks");
  const generated = settingsObject(JSON.parse(artifact.content), "generated root");
  const generatedHooks = settingsObject(generated.hooks, "generated hooks");
  const hooks: Record<string, any> = { ...existingHooks };
  const changedEvents: string[] = [];
  let ownedEntriesRemoved = 0;

  const retainUnownedEntries = (event: string, value: unknown): Record<string, any>[] => {
    const retained: Record<string, any>[] = [];
    for (const entry of eventEntries(value, event)) {
      const result = removeOwnedHandlers(entry, artifact);
      if (result.owned) ownedEntriesRemoved += 1;
      if (result.entry) retained.push(result.entry);
    }
    return retained;
  };

  for (const [event, rawGeneratedEntries] of Object.entries(generatedHooks)) {
    const generatedEntries = eventEntries(rawGeneratedEntries, event);
    const existingEntries = existingHooks[event] === undefined ? [] : eventEntries(existingHooks[event], event);
    const retained = retainUnownedEntries(event, existingEntries);
    const merged = [...retained, ...generatedEntries];
    hooks[event] = merged;
    if (semanticJson(existingEntries) !== semanticJson(merged)) changedEvents.push(event);
  }

  for (const [event, rawEntries] of Object.entries(existingHooks)) {
    if (event in generatedHooks) continue;
    const existingEntries = eventEntries(rawEntries, event);
    const retained = retainUnownedEntries(event, existingEntries);
    hooks[event] = retained;
    if (semanticJson(existingEntries) !== semanticJson(retained)) changedEvents.push(event);
  }

  const settings = { ...root, hooks };
  return {
    changed: semanticJson(root) !== semanticJson(settings),
    settings,
    changed_events: changedEvents,
    owned_entries_removed: ownedEntriesRemoved
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function activateClaudeSettings(input: {
  project_path: string;
  artifact: HostIntegrationArtifact;
  backup_root?: string;
}): Promise<ClaudeActivationResult> {
  if (input.artifact.host !== "claude")
    throw new Error("Invalid Claude settings: activation requires a Claude artifact");
  if (
    input.artifact.path !== ".claude/moryn-settings.json" ||
    input.artifact.merge_target !== ".claude/settings.local.json"
  ) {
    throw new Error("Invalid Claude settings: unexpected artifact path or merge target");
  }
  const boundary = await resolveProjectWriteTarget(input.project_path, input.artifact.merge_target, "Claude settings");
  const targetPath = boundary.target_path;
  let existingText: string | undefined;
  if (await projectFileExists(boundary, "Claude settings")) {
    existingText = await readFile(targetPath, "utf8");
  }
  let current: unknown | undefined;
  if (existingText !== undefined) {
    try {
      current = JSON.parse(existingText);
    } catch {
      throw new Error(`Invalid Claude settings JSON: ${targetPath}`);
    }
  }
  const merged = mergeClaudeSettings(current, input.artifact);
  const newText = `${JSON.stringify(merged.settings, null, 2)}\n`;
  const newDigest = digest(newText);
  await hardenProjectBackupDirectory({
    root_path: input.project_path,
    relative_path: ".claude/.moryn-backups",
    backup_name: /^settings\.local\.[a-f0-9]{16}\.json$/u,
    description: "Claude settings backup"
  });
  const backupStorage = await resolveHostConfigBackupStorage(input);
  await hardenHostConfigBackupStorage({
    storage: backupStorage,
    backup_name: /^settings\.local\.[a-f0-9]{16}\.json$/u,
    description: "Claude settings backup"
  });
  if (!merged.changed && existingText !== undefined) {
    return {
      ...merged,
      created: false,
      backup_created: false,
      target_path: targetPath,
      previous_digest: digest(existingText),
      new_digest: newDigest
    };
  }

  await ensureProjectWriteParent(boundary, "Claude settings");
  let backupPath: string | undefined;
  if (existingText !== undefined) {
    const previousDigest = digest(existingText);
    backupPath = await writeHostConfigBackup({
      storage: backupStorage,
      name: `settings.local.${previousDigest.slice(0, 16)}.json`,
      content: existingText,
      description: "Claude settings backup"
    });
  }

  const temporaryPath = join(dirname(targetPath), `.settings.local.moryn-${process.pid}-${newDigest.slice(0, 12)}.tmp`);
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
