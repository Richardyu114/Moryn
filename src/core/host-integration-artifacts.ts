import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { normalizeHostId } from "./host-adapter-registry.js";
import { ensureProjectWriteParent, projectFileExists, resolveProjectWriteTarget } from "./project-write-boundary.js";

export interface HostIntegrationArtifact {
  host: "codex" | "claude";
  path: string;
  format: "toml" | "json";
  content: string;
  merge_target: string;
  merge_instruction: string;
  activation_id: string;
  command: string;
  command_digest: string;
  expected_events: string[];
}

export interface HostRuntimeDescriptor {
  exec_file: string;
  exec_args?: string[];
  cli_entry: string;
  package_version?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function activationId(projectId: string, hostInput: string): string {
  const host = normalizeHostId(hostInput);
  if (host !== "codex" && host !== "claude")
    throw new Error(`Invalid argument: official integration unavailable for host: ${hostInput}`);
  const slug = projectId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error("Invalid argument: project_id must contain an alphanumeric character");
  return `moryn-v03-${slug}-${host}`;
}

function hookCommandBase(
  host: "codex" | "claude",
  input: { project_id: string; project_path: string; store_path: string; runtime?: HostRuntimeDescriptor }
): string {
  const executable = input.runtime
    ? [input.runtime.exec_file, ...(input.runtime.exec_args ?? []), input.runtime.cli_entry].map(shellQuote).join(" ")
    : "moryn";
  return `${executable} --store ${shellQuote(input.store_path)} host hook --host ${host} --project ${shellQuote(input.project_path)} --activation-id ${activationId(input.project_id, host)} --host-output`;
}

function claudeHook(command: string) {
  return [{ matcher: "", hooks: [{ type: "command", command }] }];
}

function codexHook(command: string) {
  return [{ hooks: [{ type: "command", command, timeout: 30, statusMessage: "Syncing Moryn context" }] }];
}

export function buildHostIntegrationArtifact(input: {
  host: string;
  project_id: string;
  project_path: string;
  store_path: string;
  runtime?: HostRuntimeDescriptor;
}): HostIntegrationArtifact {
  const host = normalizeHostId(input.host);
  if (host !== "codex" && host !== "claude")
    throw new Error(`Invalid argument: official integration unavailable for host: ${input.host}`);
  const commandBase = hookCommandBase(host, input);
  const activation_id = activationId(input.project_id, host);
  const command_digest = createHash("sha256").update(commandBase).digest("hex");
  const command = `${commandBase} --command-digest ${command_digest}`;
  if (host === "claude") {
    const expected_events = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop", "SessionEnd"];
    const content = `${JSON.stringify(
      {
        hooks: {
          SessionStart: claudeHook(command),
          UserPromptSubmit: claudeHook(command),
          PreCompact: claudeHook(command),
          PostCompact: claudeHook(command),
          Stop: claudeHook(command),
          SessionEnd: claudeHook(command)
        }
      },
      null,
      2
    )}\n`;
    return {
      host,
      path: ".claude/moryn-settings.json",
      format: "json",
      content,
      merge_target: ".claude/settings.local.json",
      merge_instruction: "Merge the hooks object from .claude/moryn-settings.json into .claude/settings.local.json.",
      activation_id,
      command,
      command_digest,
      expected_events
    };
  }
  const expected_events = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"];
  const content = `${JSON.stringify(
    {
      hooks: {
        SessionStart: codexHook(command),
        UserPromptSubmit: codexHook(command),
        PreCompact: codexHook(command),
        PostCompact: codexHook(command),
        Stop: codexHook(command)
      }
    },
    null,
    2
  )}\n`;
  return {
    host,
    path: ".codex/moryn-hooks.json",
    format: "json",
    content,
    merge_target: ".codex/hooks.json",
    merge_instruction:
      "Merge the hooks object from .codex/moryn-hooks.json into .codex/hooks.json, then review the project hook trust prompt in Codex.",
    activation_id,
    command,
    command_digest,
    expected_events
  };
}

export async function writeHostIntegrationArtifact(input: {
  host: string;
  project_id: string;
  project_path: string;
  store_path: string;
  runtime?: HostRuntimeDescriptor;
}) {
  const artifact = buildHostIntegrationArtifact(input);
  const boundary = await resolveProjectWriteTarget(input.project_path, artifact.path, `${artifact.host} integration`);
  const path = boundary.target_path;
  let existing: string | undefined;
  if (await projectFileExists(boundary, `${artifact.host} integration`)) {
    existing = await readFile(path, "utf8");
  }
  if (existing === artifact.content) return { created: false, updated: false, path, artifact };
  await ensureProjectWriteParent(boundary, `${artifact.host} integration`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, artifact.content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { created: existing === undefined, updated: existing !== undefined, path, artifact };
}
