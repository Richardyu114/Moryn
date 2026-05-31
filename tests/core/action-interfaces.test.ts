import { describe, expect, it } from "vitest";
import { actionInterfaces } from "../../src/core/action-interfaces.js";

describe("action interfaces", () => {
  it("exposes a shell-safe command line for moryn actions", () => {
    const interfaces = actionInterfaces({
      tool: "agent_finish",
      command: "moryn agent finish --summary <summary>",
      arguments: {
        project_path: "/workspace/My Project",
        current_task: "fix Bob's parser",
        agent: { client: "codex", session_id: "session 1" },
        summary: "<summary>"
      }
    });

    expect(interfaces.cli).toEqual({
      command: "moryn agent finish --summary <summary>",
      command_line: "moryn agent finish --summary '<summary>' --project '/workspace/My Project' --current-task 'fix Bob'\\''s parser' --agent codex --session-id 'session 1'",
      argv: [
        "agent", "finish",
        "--summary", "<summary>",
        "--project", "/workspace/My Project",
        "--current-task", "fix Bob's parser",
        "--agent", "codex",
        "--session-id", "session 1"
      ],
      executable: "moryn",
      args: [
        "agent", "finish",
        "--summary", "<summary>",
        "--project", "/workspace/My Project",
        "--current-task", "fix Bob's parser",
        "--agent", "codex",
        "--session-id", "session 1"
      ],
      exec_file: {
        executable: "moryn",
        args: [
          "agent", "finish",
          "--summary", "<summary>",
          "--project", "/workspace/My Project",
          "--current-task", "fix Bob's parser",
          "--agent", "codex",
          "--session-id", "session 1"
        ]
      },
      placeholders: ["summary"],
      has_placeholders: true
    });
  });

  it("accepts flattened nested argument fields when generating CLI flags", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent_client: "codex",
        agent_session_id: "session 1",
        agent_model: "gpt-5"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "agent", "status",
      "--status", "Working",
      "--agent", "codex",
      "--session-id", "session 1",
      "--model", "gpt-5"
    ]);
    expect(interfaces.cli.command_line).toBe("moryn agent status --status Working --agent codex --session-id 'session 1' --model gpt-5");
  });

  it("normalizes flattened nested argument fields when generating MCP arguments", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent_client: "codex",
        agent_session_id: "session 1",
        agent_model: "gpt-5"
      }
    });

    expect(interfaces.mcp.arguments).toEqual({
      status: "Working",
      agent: {
        client: "codex",
        session_id: "session 1",
        model: "gpt-5"
      }
    });
  });

  it("merges flattened fields with partial parent objects when generating MCP arguments", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent: { client: "codex" },
        agent_session_id: "session 1"
      }
    });

    expect(interfaces.mcp.arguments).toEqual({
      status: "Working",
      agent: {
        client: "codex",
        session_id: "session 1"
      }
    });
  });

  it("does not mutate input arguments when normalizing MCP arguments", () => {
    const input = {
      status: "Working",
      agent: { client: "codex" },
      agent_session_id: "session 1"
    };

    actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: input
    });

    expect(input).toEqual({
      status: "Working",
      agent: { client: "codex" },
      agent_session_id: "session 1"
    });
  });

  it("prefers explicit nested MCP values over duplicate flattened fields", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent: { client: "codex", session_id: "nested session" },
        agent_client: "other",
        agent_session_id: "flat session"
      }
    });

    expect(interfaces.mcp.arguments).toEqual({
      status: "Working",
      agent: {
        client: "codex",
        session_id: "nested session"
      }
    });
  });

  it("prefers literal MCP path values over duplicate flattened fields", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        "agent.client": "codex",
        agent_client: "other",
        "agent.session_id": "literal session",
        agent_session_id: "flat session"
      }
    });

    expect(interfaces.mcp.arguments).toEqual({
      status: "Working",
      agent: {
        client: "codex",
        session_id: "literal session"
      }
    });
  });

  it("does not duplicate nested CLI flags when parent and flattened fields are both present", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent: { client: "codex", session_id: "session 1" },
        agent_client: "codex",
        agent_session_id: "session 1"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "agent", "status",
      "--status", "Working",
      "--agent", "codex",
      "--session-id", "session 1"
    ]);
  });

  it("merges flattened fields with partial parent objects when generating CLI flags", () => {
    const interfaces = actionInterfaces({
      tool: "agent_status",
      command: "moryn agent status --status <status>",
      arguments: {
        status: "Working",
        agent: { client: "codex" },
        agent_session_id: "session 1"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "agent", "status",
      "--status", "Working",
      "--agent", "codex",
      "--session-id", "session 1"
    ]);
  });

  it("encodes object CLI flag values as JSON instead of object strings", () => {
    const interfaces = actionInterfaces({
      tool: "write",
      command: "moryn write --kind memory --type decision --scope project --content-json <content>",
      arguments: {
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Use structured memory.", format: "json" }
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "write",
      "--kind", "memory",
      "--type", "decision",
      "--scope", "project",
      "--content-json", "{\"text\":\"Use structured memory.\",\"format\":\"json\"}"
    ]);
    expect(interfaces.cli.command_line).toContain("--content-json '{\"text\":\"Use structured memory.\",\"format\":\"json\"}'");
  });

  it("merges flattened content fields into one JSON CLI flag", () => {
    const interfaces = actionInterfaces({
      tool: "write",
      command: "moryn write --kind memory --type decision --scope project --content-json <content>",
      arguments: {
        kind: "memory",
        type: "decision",
        scope: "project",
        content_text: "Use flattened content.",
        content_format: "json"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "write",
      "--kind", "memory",
      "--type", "decision",
      "--scope", "project",
      "--content-json", "{\"text\":\"Use flattened content.\",\"format\":\"json\"}"
    ]);
    expect(interfaces.mcp.arguments).toEqual({
      kind: "memory",
      type: "decision",
      scope: "project",
      content: { text: "Use flattened content.", format: "json" }
    });
  });

  it("accepts literal MCP path keys when generating transport arguments", () => {
    const interfaces = actionInterfaces({
      tool: "write",
      command: "moryn write --kind memory --type decision --scope project --content-json <content>",
      arguments: {
        kind: "memory",
        type: "decision",
        scope: "project",
        "content.text": "Use recovery hint paths.",
        "content.format": "json"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "write",
      "--kind", "memory",
      "--type", "decision",
      "--scope", "project",
      "--content-json", "{\"text\":\"Use recovery hint paths.\",\"format\":\"json\"}"
    ]);
    expect(interfaces.mcp.arguments).toEqual({
      kind: "memory",
      type: "decision",
      scope: "project",
      content: { text: "Use recovery hint paths.", format: "json" }
    });
  });

  it("normalizes literal MCP path keys for nested MCP-only metadata", () => {
    const interfaces = actionInterfaces({
      tool: "write",
      command: "moryn write --kind memory --type decision --scope project --text <text>",
      arguments: {
        kind: "memory",
        type: "decision",
        scope: "project",
        text: "Use explicit source metadata.",
        "source.client": "codex",
        "source.session_id": "session 1"
      }
    });

    expect(interfaces.cli.argv).toEqual([
      "write",
      "--kind", "memory",
      "--type", "decision",
      "--scope", "project",
      "--text", "Use explicit source metadata."
    ]);
    expect(interfaces.mcp.arguments).toEqual({
      kind: "memory",
      type: "decision",
      scope: "project",
      text: "Use explicit source metadata.",
      source: { client: "codex", session_id: "session 1" }
    });
  });

  it("prefers literal MCP source path values over duplicate flattened source fields", () => {
    const interfaces = actionInterfaces({
      tool: "write",
      command: "moryn write --kind memory --type decision --scope project --text <text>",
      arguments: {
        kind: "memory",
        type: "decision",
        scope: "project",
        text: "Use explicit source metadata.",
        "source.client": "codex",
        source_client: "other",
        "source.session_id": "literal session",
        source_session_id: "flat session"
      }
    });

    expect(interfaces.mcp.arguments).toEqual({
      kind: "memory",
      type: "decision",
      scope: "project",
      text: "Use explicit source metadata.",
      source: {
        client: "codex",
        session_id: "literal session"
      }
    });
  });

  it("uses the direct executable when runtime actions are not launched through moryn", () => {
    const interfaces = actionInterfaces({
      tool: "moryn-agent-smoke",
      command: "moryn-agent-smoke --remote <remote>",
      arguments: {
        remote: "git@github.com:you/moryn store.git"
      }
    });

    expect(interfaces.cli).toMatchObject({
      executable: "moryn-agent-smoke",
      args: ["--remote", "git@github.com:you/moryn store.git"],
      exec_file: {
        executable: "moryn-agent-smoke",
        args: ["--remote", "git@github.com:you/moryn store.git"]
      },
      argv: ["moryn-agent-smoke", "--remote", "git@github.com:you/moryn store.git"],
      command_line: "moryn-agent-smoke --remote 'git@github.com:you/moryn store.git'",
      placeholders: [],
      has_placeholders: false
    });
  });
});
