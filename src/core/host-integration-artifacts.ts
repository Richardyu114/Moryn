import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeHostId } from "./host-adapter-registry.js";

export interface HostIntegrationArtifact {
  host: "codex" | "claude";
  path: string;
  format: "toml" | "json";
  content: string;
  merge_target: string;
  merge_instruction: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(host: "codex" | "claude", input: { project_path: string; store_path: string }): string {
  return `moryn --store ${shellQuote(input.store_path)} host hook --host ${host} --project ${shellQuote(input.project_path)} --device-id \"$MORYN_DEVICE_ID\"`;
}

function claudeHook(command: string) {
  return [{ matcher: "", hooks: [{ type: "command", command }] }];
}

export function buildHostIntegrationArtifact(input: { host: string; project_path: string; store_path: string }): HostIntegrationArtifact {
  const host = normalizeHostId(input.host);
  if (host !== "codex" && host !== "claude") throw new Error(`Invalid argument: official integration unavailable for host: ${input.host}`);
  const command = hookCommand(host, input);
  if (host === "claude") {
    const content = `${JSON.stringify({ hooks: {
      SessionStart: claudeHook(command),
      PreCompact: claudeHook(command),
      PostCompact: claudeHook(command),
      Stop: claudeHook(command),
      SessionEnd: claudeHook(command)
    } }, null, 2)}\n`;
    return {
      host,
      path: ".claude/moryn-settings.json",
      format: "json",
      content,
      merge_target: ".claude/settings.local.json",
      merge_instruction: "Merge the hooks object from .claude/moryn-settings.json into .claude/settings.local.json."
    };
  }
  const content = [
    "# Moryn-owned Codex lifecycle hooks fragment.",
    "# Merge these hook tables into the project Codex config supported by your Codex version.",
    "",
    ...["SessionStart", "PreCompact", "PostCompact", "Stop"].flatMap((event) => [
      `[[hooks.${event}]]`,
      `command = ${JSON.stringify(command)}`,
      ""
    ])
  ].join("\n");
  return {
    host,
    path: ".codex/moryn-hooks.toml",
    format: "toml",
    content,
    merge_target: ".codex/config.toml",
    merge_instruction: "Merge .codex/moryn-hooks.toml into the project Codex config using the hook schema supported by your installed Codex version."
  };
}

export async function writeHostIntegrationArtifact(input: { host: string; project_path: string; store_path: string }) {
  const artifact = buildHostIntegrationArtifact(input);
  const path = join(input.project_path, artifact.path);
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch {}
  if (existing === artifact.content) return { created: false, updated: false, path, artifact };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, artifact.content, "utf8");
  return { created: existing === undefined, updated: existing !== undefined, path, artifact };
}
