import { describe, expect, it } from "vitest";
import { knowledgeProtocolForHost } from "../../src/core/knowledge-protocol.js";

describe("host knowledge protocol", () => {
  it.each([
    ["codex", "Codex"],
    ["claude", "Claude Code"]
  ] as const)("defines one autonomous knowledge loop for %s", (host, displayName) => {
    const protocol = knowledgeProtocolForHost(host);

    expect(protocol.host).toBe(host);
    expect(protocol.display_name).toBe(displayName);
    expect(protocol.phases.map((phase) => phase.id)).toEqual([
      "recall_before_external_exploration",
      "follow_recall_actions",
      "capture_confirmed_learning",
      "preserve_before_compaction"
    ]);
    expect(protocol.rules_by_id.recall_first).toMatchObject({
      trigger: "uncertain_durable_knowledge",
      action: "call_moryn_recall_before_broad_external_exploration"
    });
    expect(protocol.rules_by_id.host_owns_exploration).toMatchObject({
      action: "host_agent_explores_project_local_web_or_user_sources"
    });
    expect(protocol.rules_by_id.evidence_before_learning).toMatchObject({
      action: "queue_learning_delta_only_after_reusable_conclusion_is_supported"
    });
    expect(protocol.rules_by_id.unsupported_inference).toMatchObject({
      action: "do_not_canonicalize_unsupported_agent_inference"
    });
    expect(protocol.rules_by_id.compact_safety).toMatchObject({
      action: "checkpoint_resolved_learning_and_unresolved_investigation_before_host_compaction"
    });
    expect(protocol.prompt).toContain("Moryn recall");
    expect(protocol.prompt).toContain("before broad external exploration");
    expect(protocol.prompt).toContain("Learning Delta");
    expect(protocol.prompt).toContain("before compaction");
  });
});
