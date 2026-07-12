import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { detectSensitiveContent } from "./sensitive.js";

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 200;
const MAX_USER_TEXT = 2000;
const MAX_ASSISTANT_TEXT = 4000;

export type HostTranscriptEvidenceStatus = "available" | "protected" | "unavailable" | "invalid";

export interface HostTranscriptEvidence {
  status: HostTranscriptEvidenceStatus;
  reason?: "missing_path" | "not_found" | "not_regular_file" | "symbolic_link" | "outside_allowed_roots" | "unreadable" | "no_public_text" | "sensitive_content";
  last_user_message?: string;
  last_assistant_message?: string;
  lines_considered: number;
  malformed_lines: number;
  truncated: boolean;
}

export interface ReadHostTranscriptEvidenceInput {
  host: "codex" | "claude";
  transcript_path?: string;
  allowed_roots: string[];
}

export function defaultHostTranscriptRoots(host: "codex" | "claude", env: NodeJS.ProcessEnv = process.env): string[] {
  return host === "codex"
    ? [resolve(env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"), "sessions")]
    : [resolve(homedir(), ".claude", "projects")];
}

function boundedText(value: unknown, maxLength: number): { text?: string; truncated: boolean } {
  if (typeof value !== "string") return { truncated: false };
  const text = value.trim();
  if (!text) return { truncated: false };
  return { text: text.slice(0, maxLength), truncated: text.length > maxLength };
}

function textBlocks(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "text")
    .map((item) => (item as Record<string, unknown>).text)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n")
    .trim();
  return text || undefined;
}

function codexText(value: Record<string, unknown>): { user?: string; assistant?: string } {
  if (value.type !== "event_msg" || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return {};
  const payload = value.payload as Record<string, unknown>;
  if (payload.type === "user_message" && typeof payload.message === "string") return { user: payload.message };
  if (payload.type === "agent_message" && typeof payload.message === "string") return { assistant: payload.message };
  if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") return { assistant: payload.last_agent_message };
  return {};
}

function claudeText(value: Record<string, unknown>): { user?: string; assistant?: string } {
  if (value.type === "last-prompt" && typeof value.lastPrompt === "string") return { user: value.lastPrompt };
  if ((value.type !== "user" && value.type !== "assistant") || !value.message || typeof value.message !== "object" || Array.isArray(value.message)) return {};
  const message = value.message as Record<string, unknown>;
  const content = textBlocks(message.content);
  if (!content) return {};
  return value.type === "user" ? { user: content } : { assistant: content };
}

function insideRoot(path: string, root: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

export async function readHostTranscriptEvidence(input: ReadHostTranscriptEvidenceInput): Promise<HostTranscriptEvidence> {
  if (!input.transcript_path) return { status: "unavailable", reason: "missing_path", lines_considered: 0, malformed_lines: 0, truncated: false };
  const requestedPath = resolve(input.transcript_path);
  let fileStat;
  try {
    fileStat = await lstat(requestedPath);
  } catch (error) {
    return { status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "unreadable", lines_considered: 0, malformed_lines: 0, truncated: false };
  }
  if (fileStat.isSymbolicLink()) return { status: "invalid", reason: "symbolic_link", lines_considered: 0, malformed_lines: 0, truncated: false };
  if (!fileStat.isFile()) return { status: "invalid", reason: "not_regular_file", lines_considered: 0, malformed_lines: 0, truncated: false };
  let resolvedPath: string;
  let roots: string[];
  try {
    resolvedPath = await realpath(requestedPath);
    roots = await Promise.all(input.allowed_roots.map((root) => realpath(resolve(root))));
  } catch {
    return { status: "invalid", reason: "outside_allowed_roots", lines_considered: 0, malformed_lines: 0, truncated: false };
  }
  if (!roots.some((root) => insideRoot(resolvedPath, root))) return { status: "invalid", reason: "outside_allowed_roots", lines_considered: 0, malformed_lines: 0, truncated: false };

  let raw: string;
  let byteTruncated = false;
  try {
    const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, MAX_BYTES);
      const offset = Math.max(0, stat.size - length);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      raw = buffer.toString("utf8");
      if (offset > 0) {
        const newline = raw.indexOf("\n");
        raw = newline >= 0 ? raw.slice(newline + 1) : "";
        byteTruncated = true;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unavailable", reason: "unreadable", lines_considered: 0, malformed_lines: 0, truncated: false };
  }

  const allLines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const lines = allLines.slice(-MAX_LINES);
  let malformedLines = 0;
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const extracted = input.host === "codex" ? codexText(value as Record<string, unknown>) : claudeText(value as Record<string, unknown>);
      if (extracted.user?.trim()) lastUser = extracted.user;
      if (extracted.assistant?.trim()) lastAssistant = extracted.assistant;
    } catch {
      malformedLines += 1;
    }
  }
  const user = boundedText(lastUser, MAX_USER_TEXT);
  const assistant = boundedText(lastAssistant, MAX_ASSISTANT_TEXT);
  const truncated = byteTruncated || allLines.length > MAX_LINES || user.truncated || assistant.truncated;
  const sensitive = [user.text, assistant.text].filter((value): value is string => Boolean(value)).some((value) => detectSensitiveContent(value).sensitive);
  if (sensitive) return { status: "protected", reason: "sensitive_content", lines_considered: lines.length, malformed_lines: malformedLines, truncated };
  if (!user.text && !assistant.text) return { status: "unavailable", reason: "no_public_text", lines_considered: lines.length, malformed_lines: malformedLines, truncated };
  return {
    status: "available",
    ...(user.text ? { last_user_message: user.text } : {}),
    ...(assistant.text ? { last_assistant_message: assistant.text } : {}),
    lines_considered: lines.length,
    malformed_lines: malformedLines,
    truncated
  };
}
