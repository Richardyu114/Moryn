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

function entryCommand(entry: Record<string, any>): string | undefined {
  if (!Array.isArray(entry.hooks)) return undefined;
  for (const hook of entry.hooks) {
    if (hook && typeof hook === "object" && !Array.isArray(hook) && typeof hook.command === "string")
      return hook.command;
  }
  return undefined;
}

function isOwned(entry: Record<string, any>, activationId: string): boolean {
  const command = entryCommand(entry);
  return command?.split(/\s+/).includes(activationId) === true;
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

  for (const [event, rawGeneratedEntries] of Object.entries(generatedHooks)) {
    const generatedEntries = eventEntries(rawGeneratedEntries, event);
    const existingEntries = existingHooks[event] === undefined ? [] : eventEntries(existingHooks[event], event);
    const retained = existingEntries.filter((entry) => {
      const owned = isOwned(entry, artifact.activation_id);
      if (owned) ownedEntriesRemoved += 1;
      return !owned;
    });
    const merged = [...retained, ...generatedEntries];
    hooks[event] = merged;
    if (semanticJson(existingEntries) !== semanticJson(merged)) changedEvents.push(event);
  }

  for (const [event, rawEntries] of Object.entries(existingHooks)) {
    if (event in generatedHooks) continue;
    eventEntries(rawEntries, event);
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
    const backupDir = await ensureProjectWriteDirectory(
      boundary.root_path,
      ".claude/.moryn-backups",
      "Claude settings backup"
    );
    backupPath = join(backupDir, `settings.local.${previousDigest.slice(0, 16)}.json`);
    try {
      const backupStat = await lstat(backupPath);
      if (!backupStat.isFile() || backupStat.isSymbolicLink())
        throw new Error(`Invalid Claude settings backup: ${backupPath}`);
      if ((await readFile(backupPath, "utf8")) !== existingText)
        throw new Error(`Invalid Claude settings backup content: ${backupPath}`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        await writeFile(backupPath, existingText, { encoding: "utf8", flag: "wx" });
      else throw error;
    }
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
