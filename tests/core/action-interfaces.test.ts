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
      command_line: "moryn-agent-smoke --remote 'git@github.com:you/moryn store.git'"
    });
  });
});
