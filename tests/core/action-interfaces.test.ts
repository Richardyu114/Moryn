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
