export interface AgentIdentityDisplay {
  client: string;
  family: string;
  confidence: "known" | "generic" | "unknown";
  raw_client: string;
}

const KNOWN_AGENT_PATTERNS: Array<{ family: string; display: string; patterns: RegExp[] }> = [
  { family: "codex", display: "Codex", patterns: [/^codex(?:[-_].*)?$/] },
  { family: "claude", display: "Claude", patterns: [/^claude(?:[-_].*)?$/] },
  { family: "kimi", display: "Kimi", patterns: [/^kimi(?:[-_].*)?$/] },
  { family: "gemini", display: "Gemini", patterns: [/^gemini(?:[-_].*)?$/] }
];

const GENERIC_LOCAL_CLIENTS = new Set(["agent", "cli", "mcp", "moryn"]);

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

export function normalizeAgentIdentity(rawClient: string | undefined): AgentIdentityDisplay {
  const raw = rawClient?.trim() || "unknown";
  const normalized = raw.toLowerCase();

  for (const agent of KNOWN_AGENT_PATTERNS) {
    if (agent.patterns.some((pattern) => pattern.test(normalized))) {
      return {
        client: agent.display,
        family: agent.family,
        confidence: "known",
        raw_client: raw
      };
    }
  }

  if (GENERIC_LOCAL_CLIENTS.has(normalized)) {
    return {
      client: "Moryn Local",
      family: "moryn-local",
      confidence: "generic",
      raw_client: raw
    };
  }

  return {
    client: titleCase(raw),
    family: normalized || "unknown",
    confidence: normalized === "unknown" ? "unknown" : "generic",
    raw_client: raw
  };
}
