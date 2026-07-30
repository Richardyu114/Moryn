import { describe, expect, it } from "vitest";
import {
  buildMemoryRetentionReadModel,
  buildMemoryRetentionView,
  inferMemoryLayer,
  type MemoryRetentionMetadataV2,
  parseMemoryRetentionMetadata,
  protectedMemorySignals
} from "../../src/core/memory-retention.js";
import { buildSessionFoldCoverageAttestation, planSessionFold } from "../../src/core/session-fold.js";
import type { MorynRecord, RecordState } from "../../src/core/types.js";

const NOW = "2026-07-20T00:00:00.000Z";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "rec-a",
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: "Temporary observation" },
    state: "candidate",
    confidence: 0.7,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    source: { client: "codex", session_id: "session-a" },
    ...overrides
  };
}

function metadata(value: Omit<MemoryRetentionMetadataV2, "version">): MemoryRetentionMetadataV2 {
  return { version: 2, ...value };
}

describe("memory retention layer inference", () => {
  it.each([
    ["agent note", record({ kind: "agent_note", type: "observation" }), "L0"],
    ["checkpoint", record({ kind: "session_summary", type: "checkpoint" }), "L0"],
    ["status", record({ kind: "session_summary", type: "status" }), "L0"],
    ["session summary", record({ kind: "session_summary", type: "summary" }), "L1"],
    ["handoff", record({ kind: "session_summary", type: "handoff" }), "L1"],
    ["session-scoped memory", record({ type: "fact", scope: "session", project_id: undefined }), "L1"],
    ["skill", record({ kind: "skill", type: "procedure" }), "L2"],
    ["project memory", record({ kind: "memory", type: "decision" }), "L2"],
    ["project summary", record({ kind: "memory", type: "summary" }), "L2"],
    [
      "global preference",
      record({ kind: "memory", type: "writing-style-preference", scope: "global", project_id: undefined }),
      "L3"
    ],
    ["soul", record({ kind: "soul", type: "principle", scope: "global", project_id: undefined }), "L3"]
  ] as const)("maps %s to %s", (_label, input, expected) => {
    expect(inferMemoryLayer(input)).toBe(expected);
    expect(buildMemoryRetentionView(input, { now: NOW }).layer.level).toBe(expected);
  });

  it("accepts explicit elevation but enforces intrinsic identity and skill floors", () => {
    const elevated = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        content: { text: "Reusable observation", memory_retention: metadata({ layer: "L2" }) }
      })
    );
    const soul = buildMemoryRetentionView(
      record({
        kind: "soul",
        type: "principle",
        scope: "global",
        project_id: undefined,
        content: { text: "Be concise", memory_retention: metadata({ layer: "L0" }) }
      })
    );
    const skill = buildMemoryRetentionView(
      record({
        kind: "skill",
        type: "procedure",
        content: { text: "Run checks", memory_retention: metadata({ layer: "L0" }) }
      })
    );

    expect(elevated.layer).toMatchObject({ level: "L2", source: "metadata" });
    expect(soul.layer).toMatchObject({ level: "L3", source: "safety_floor" });
    expect(skill.layer).toMatchObject({ level: "L2", source: "safety_floor" });
    expect(soul.reasons.map((reason) => reason.code)).toContain("layer.metadata.safety_floor");
  });
});

describe("memory retention trust and v1 compatibility", () => {
  it.each(["raw", "candidate", "canonical", "archived", "quarantined"] as const)(
    "maps the %s state without throwing",
    (state) => {
      const view = buildMemoryRetentionView(
        record({
          state,
          visibility: state === "archived" || state === "quarantined" ? state : "active"
        }),
        { now: NOW }
      );

      expect(view.trust.source_state).toBe(state);
      expect(view.trust.state).toBe(state === "archived" ? "legacy_unknown" : state);
      expect(view.retention.tier).toBe(
        state === "archived" || state === "quarantined" ? "cold" : state === "canonical" ? "hot" : "warm"
      );
    }
  );

  it("maps v1 archived records to cold even when metadata requests hot and pinned", () => {
    const view = buildMemoryRetentionView(
      record({
        state: "archived",
        visibility: "archived",
        content: {
          text: "Historical fact",
          memory_retention: metadata({
            trust_state: "canonical",
            retention: { tier: "hot", pinned: true }
          })
        }
      })
    );

    expect(view.trust).toMatchObject({ state: "canonical", source: "metadata", source_state: "archived" });
    expect(view.retention).toMatchObject({ tier: "cold", source: "compatibility", pinned: true });
    expect(view.reasons.map((reason) => reason.code)).toContain("retention.v1_archived_to_cold");
  });

  it("keeps active replay state authoritative over conflicting metadata trust", () => {
    const view = buildMemoryRetentionView(
      record({
        state: "candidate",
        content: {
          text: "Candidate fact",
          memory_retention: metadata({ trust_state: "canonical" })
        }
      })
    );

    expect(view.trust).toMatchObject({ state: "candidate", source: "record" });
    expect(view.reasons.map((reason) => reason.code)).toContain("trust.metadata.ignored_for_active_record");
  });
});

describe("memory retention metadata", () => {
  it("parses policy, validity, usage, and lineage into a deterministic view", () => {
    const digest = "A".repeat(64);
    const input = record({
      kind: "agent_note",
      provenance: { derived_from: ["rec-z", "rec-a"] },
      content: {
        text: "Reusable observation",
        memory_retention: metadata({
          layer: "L2",
          retention: { tier: "warm", pinned: true, never_forget: true },
          policy: { id: "project-balanced", retain_until: "2026-08-01T00:00:00.000Z" },
          validity: {
            valid_until: "2026-07-19T00:00:00.000Z",
            stale_at: "2026-07-10T00:00:00.000Z",
            last_verified_at: "2026-07-01T00:00:00.000Z"
          },
          usage: {
            last_recalled_at: "2026-07-18T00:00:00.000Z",
            last_useful_at: "2026-07-18T00:00:00.000Z",
            recall_count: 8,
            useful_count: 5
          },
          lineage: {
            derived_from: ["rec-b", "rec-a", "rec-b"],
            covered_record_ids: ["rec-source-b", "rec-source-a"],
            covered_by_record_ids: ["rec-rollup"],
            source_digests: { "rec-source-a": digest },
            compression_level: 2,
            coverage_verified: true
          }
        })
      }
    });

    const parsed = parseMemoryRetentionMetadata(input);
    const view = buildMemoryRetentionView(input, { now: NOW });

    expect(parsed).toMatchObject({ present: true, supported: true, valid: true, warnings: [] });
    expect(view.layer).toMatchObject({ level: "L2", source: "metadata" });
    expect(view.retention).toMatchObject({
      tier: "hot",
      source: "safety",
      pinned: true,
      never_forget: true,
      policy: {
        id: "project-balanced",
        source: "metadata",
        retain_until: "2026-08-01T00:00:00.000Z",
        window_status: "active"
      }
    });
    expect(view.validity).toEqual({
      status: "expired",
      valid_until: "2026-07-19T00:00:00.000Z",
      stale_at: "2026-07-10T00:00:00.000Z",
      last_verified_at: "2026-07-01T00:00:00.000Z"
    });
    expect(view.usage).toEqual({
      last_recalled_at: "2026-07-18T00:00:00.000Z",
      last_useful_at: "2026-07-18T00:00:00.000Z",
      recall_count: 8,
      useful_count: 5,
      rejected_count: 0
    });
    expect(view.lineage).toEqual({
      derived_from: ["rec-a", "rec-b", "rec-z"],
      covered_record_ids: ["rec-source-a", "rec-source-b"],
      covered_by_record_ids: ["rec-rollup"],
      source_digests: { "rec-source-a": digest.toLowerCase() },
      compression_level: 2,
      coverage_verified: true
    });
  });

  it("uses legacy valid_until and does not depend on wall-clock time", () => {
    const input = record({ content: { text: "Temporary fact", valid_until: "2026-07-19T00:00:00.000Z" } });

    expect(buildMemoryRetentionView(input).validity.status).toBe("not_evaluated");
    const evaluated = buildMemoryRetentionView(input, { now: NOW });
    expect(evaluated.validity).toMatchObject({
      status: "expired",
      valid_until: "2026-07-19T00:00:00.000Z"
    });
    expect(evaluated.reasons.map((reason) => reason.code)).toContain("validity.legacy_valid_until");
  });

  it("accepts verified coverage on both rollups and covered source records", () => {
    const rollup = record({
      content: {
        text: "Session rollup",
        memory_retention: metadata({
          lineage: { covered_record_ids: ["rec-source"], coverage_verified: true }
        })
      }
    });
    const source = record({
      content: {
        text: "Temporary trace",
        memory_retention: metadata({
          lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
        })
      }
    });

    expect(parseMemoryRetentionMetadata(rollup)).toMatchObject({ valid: true });
    expect(buildMemoryRetentionView(rollup).lineage.coverage_verified).toBe(true);
    expect(parseMemoryRetentionMetadata(source)).toMatchObject({ valid: true });
    expect(buildMemoryRetentionView(source).lineage.coverage_verified).toBe(true);
  });

  it("clamps inconsistent useful counts and returns warning paths without values", () => {
    const input = record({
      content: {
        text: "Observation",
        memory_retention: metadata({ usage: { recall_count: 2, useful_count: 9 } })
      }
    });
    const parsed = parseMemoryRetentionMetadata(input);
    const view = buildMemoryRetentionView(input);

    expect(parsed.valid).toBe(false);
    expect(parsed.warnings).toContainEqual({
      code: "inconsistent_value",
      path: "content.memory_retention.usage.useful_count"
    });
    expect(view.usage).toMatchObject({ recall_count: 2, useful_count: 2 });
    expect(JSON.stringify(parsed.warnings)).not.toContain("9");
  });

  it("falls back safely for malformed and unsupported metadata", () => {
    const malformed = record({
      content: {
        text: "Observation",
        memory_retention: {
          version: 2,
          layer: "L9",
          retention: "cold",
          policy: { id: 123, retain_until: "tomorrow" },
          validity: { valid_until: false },
          usage: { recall_count: -1 },
          lineage: { covered_by_record_ids: ["", 3], coverage_verified: true }
        }
      }
    } as MorynRecord);
    const unsupported = record({
      content: { text: "Observation", memory_retention: { version: 99, retention: { tier: "purged" } } }
    } as MorynRecord);

    const malformedView = buildMemoryRetentionView(malformed, { now: "not-a-date" });
    const unsupportedView = buildMemoryRetentionView(unsupported, { now: NOW });

    expect(malformedView.metadata).toMatchObject({ present: true, supported: true, valid: false });
    expect(malformedView.layer).toMatchObject({ level: "L2", source: "inferred" });
    expect(malformedView.retention).toMatchObject({ tier: "warm", source: "default" });
    expect(malformedView.warnings.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        "content.memory_retention.layer",
        "content.memory_retention.retention",
        "content.memory_retention.policy.id",
        "content.memory_retention.policy.retain_until",
        "content.memory_retention.validity.valid_until",
        "content.memory_retention.usage.recall_count",
        "content.memory_retention.lineage.coverage_verified",
        "options.now"
      ])
    );
    expect(unsupportedView.metadata).toMatchObject({ present: true, supported: false, valid: false });
    expect(unsupportedView.retention.tier).toBe("warm");
    expect(unsupportedView.metadata.warnings).toEqual([
      { code: "unsupported_version", path: "content.memory_retention.version" }
    ]);
  });

  it("never treats partially malformed coverage as verified", () => {
    const input = record({
      kind: "agent_note",
      content: {
        text: "Temporary trace",
        memory_retention: {
          version: 2,
          retention: { tier: "cold" },
          lineage: {
            covered_by_record_ids: ["rec-rollup", 7],
            coverage_verified: true
          }
        }
      }
    } as MorynRecord);
    const parsed = parseMemoryRetentionMetadata(input);
    const view = buildMemoryRetentionView(input);

    expect(parsed.metadata?.lineage.coverage_verified).toBe(false);
    expect(view.lineage.coverage_verified).toBe(false);
    expect(view.safety.automatic_purge_safe).toBe(false);
    expect(view.safety.purge_blockers).toContain("not_verified_covered");
  });

  it("falls back when the metadata root is not an object", () => {
    const input = record({ content: { text: "Observation", memory_retention: "purged" } });
    const parsed = parseMemoryRetentionMetadata(input);

    expect(parsed).toEqual({
      present: true,
      supported: false,
      valid: false,
      warnings: [{ code: "invalid_type", path: "content.memory_retention" }]
    });
    expect(buildMemoryRetentionView(input).retention.tier).toBe("warm");
  });
});

describe("memory retention safety", () => {
  it("allows only covered cold L0 candidates to pass structural purge checks", () => {
    const safe = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        type: "observation",
        content: {
          text: "Temporary trace",
          memory_retention: metadata({
            retention: { tier: "cold" },
            lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
          })
        }
      })
    );

    expect(safe.layer.level).toBe("L0");
    expect(safe.safety).toMatchObject({
      automatic_purge_safe: true,
      purge_blockers: []
    });
    expect(safe.reasons.map((reason) => reason.code)).toContain("safety.purge.structurally_safe");
  });

  it("blocks private, conflicting, durable, and identity records", () => {
    const privateView = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        tags: [" Private "],
        content: {
          text: "Temporary trace",
          memory_retention: metadata({
            retention: { tier: "purged" },
            lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
          })
        }
      })
    );
    const conflictView = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        conflict: { kind: "semantic", with: ["rec-b"], resolution: "needs_review" },
        content: { text: "Temporary trace" }
      })
    );
    const skillView = buildMemoryRetentionView(record({ kind: "skill", type: "procedure" }));
    const soulView = buildMemoryRetentionView(
      record({ kind: "soul", type: "principle", scope: "global", project_id: undefined })
    );

    expect(privateView.retention).toMatchObject({ tier: "cold", source: "safety" });
    expect(privateView.safety.archive_blockers).toContain("private");
    expect(privateView.safety.purge_blockers).toContain("private");
    expect(conflictView.safety.archive_blockers).toContain("conflict");
    expect(skillView.safety.purge_blockers).toContain("durable_kind");
    expect(soulView.retention.never_forget).toBe(true);
    expect(soulView.safety.purge_blockers).toEqual(
      expect.arrayContaining(["durable_kind", "identity_layer", "never_forget"])
    );
  });

  it.each([
    ["content privacy", { privacy: "private" }],
    ["local-only distribution", { distribution: "local_only" }]
  ] as const)("marks records with %s as private and blocks automatic retention mutation", (_label, privacyMarker) => {
    const view = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        content: {
          text: "Temporary trace",
          ...privacyMarker,
          memory_retention: metadata({
            retention: { tier: "purged" },
            lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
          })
        }
      })
    );

    expect(view.safety.private).toBe(true);
    expect(view.retention).toMatchObject({ tier: "cold", source: "safety" });
    expect(view.safety.archive_blockers).toContain("private");
    expect(view.safety.purge_blockers).toContain("private");
  });

  it("detects protected facts without scanning retention metadata itself", () => {
    const protectedRecord = record({
      kind: "agent_note",
      type: "observation",
      content: {
        text: "Never run git push before v0.4 on 2026-07-20 at src/core/file.ts; user prefers private security.",
        memory_retention: metadata({
          policy: { id: "v9.9-metadata-only", retain_until: "2030-01-01T00:00:00.000Z" }
        })
      }
    });
    const metadataOnly = record({
      kind: "agent_note",
      type: "observation",
      content: {
        text: "Temporary trace",
        memory_retention: metadata({
          policy: { id: "security-v9.9", retain_until: "2030-01-01T00:00:00.000Z" }
        })
      }
    });

    expect(protectedMemorySignals(protectedRecord)).toEqual([
      "command",
      "date",
      "negation_or_requirement",
      "number",
      "path",
      "permission_or_security",
      "preference_or_identity",
      "version"
    ]);
    expect(protectedMemorySignals(metadataOnly)).toEqual([]);
    expect(
      protectedMemorySignals(
        record({ kind: "agent_note", type: "observation", content: { text: "Private progress is complete" } })
      )
    ).not.toContain("permission_or_security");
    expect(
      protectedMemorySignals(
        record({ kind: "agent_note", type: "observation", content: { text: "Rotate the private key" } })
      )
    ).toContain("permission_or_security");
    const view = buildMemoryRetentionView(protectedRecord);
    expect(view.safety.archive_blockers).toContain("protected_content");
    expect(view.safety.purge_blockers).toContain("protected_content");
  });

  it("permits reversible archive after verified coverage but never purges protected content", () => {
    const view = buildMemoryRetentionView(
      record({
        kind: "agent_note",
        type: "observation",
        content: {
          text: "Never publish this decision",
          memory_retention: metadata({
            lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
          })
        }
      })
    );

    expect(view.safety.archive_blockers).not.toContain("protected_content");
    expect(view.safety.automatic_archive_safe).toBe(true);
    expect(view.safety.purge_blockers).toContain("protected_content");
    expect(view.safety.automatic_purge_safe).toBe(false);
  });

  it("treats pinned and never-forget as separate controls", () => {
    const pinned = buildMemoryRetentionView(
      record({
        content: {
          text: "Ordinary fact",
          memory_retention: metadata({ retention: { tier: "cold", pinned: true } })
        }
      })
    );
    const neverForget = buildMemoryRetentionView(
      record({
        content: {
          text: "Ordinary fact",
          memory_retention: metadata({ retention: { tier: "cold", never_forget: true } })
        }
      })
    );

    expect(pinned.retention).toMatchObject({ tier: "hot", pinned: true, never_forget: false });
    expect(pinned.safety.archive_blockers).toContain("pinned");
    expect(neverForget.retention).toMatchObject({ tier: "cold", pinned: false, never_forget: true });
    expect(neverForget.safety.purge_blockers).toContain("never_forget");
  });
});

describe("memory retention read model", () => {
  it("is deterministic across input and metadata-list ordering", () => {
    const first = record({
      id: "rec-b",
      kind: "agent_note",
      content: {
        text: "Trace",
        memory_retention: metadata({
          lineage: {
            derived_from: ["rec-z", "rec-a"],
            covered_record_ids: ["rec-y", "rec-b"]
          }
        })
      }
    });
    const firstReordered = record({
      id: "rec-b",
      kind: "agent_note",
      content: {
        text: "Trace",
        memory_retention: metadata({
          lineage: {
            derived_from: ["rec-a", "rec-z"],
            covered_record_ids: ["rec-b", "rec-y"]
          }
        })
      }
    });
    const second = record({
      id: "rec-a",
      kind: "soul",
      type: "principle",
      scope: "global",
      project_id: undefined,
      state: "canonical"
    });

    const left = buildMemoryRetentionReadModel([first, second], { now: NOW });
    const right = buildMemoryRetentionReadModel([second, firstReordered], { now: NOW });

    expect(left).toEqual(right);
    expect(left.records.map((view) => view.record_id)).toEqual(["rec-a", "rec-b"]);
    expect(left).toMatchObject({
      version: 2,
      generated_at: NOW,
      stats: {
        total_records: 2,
        layers: { L0: 1, L1: 0, L2: 0, L3: 1 },
        tiers: { hot: 1, warm: 1, cold: 0, purged: 0 },
        never_forget_records: 1
      }
    });
  });

  it("counts malformed metadata and every trust state", () => {
    const states: RecordState[] = ["raw", "candidate", "canonical", "archived", "quarantined"];
    const records = states.map((state, index) =>
      record({
        id: `rec-${index}`,
        state,
        visibility: state === "archived" || state === "quarantined" ? state : "active",
        content: index === 0 ? { text: "Trace", memory_retention: { version: 99 } } : { text: "Trace" }
      })
    );

    const model = buildMemoryRetentionReadModel(records, { now: NOW });
    expect(model.stats).toMatchObject({
      total_records: 5,
      trust_states: { raw: 1, candidate: 1, canonical: 1, legacy_unknown: 1, quarantined: 1 },
      tiers: { hot: 1, warm: 2, cold: 2, purged: 0 },
      malformed_metadata_records: 1
    });
  });

  it("projects reverse coverage only when a verified rollup digest matches the source", () => {
    const identity = { project_id: "moryn", session_id: "session-a" };
    const status = record({
      id: "rec-status",
      kind: "session_summary",
      type: "status",
      content: { text: "trace", memory_retention: metadata({ trust_state: "candidate" }) },
      updated_at: "2026-07-01T00:01:00.000Z"
    });
    const final = record({
      id: "rec-final",
      kind: "session_summary",
      type: "summary",
      content: {
        text: "trace done",
        session_fold_coverage: buildSessionFoldCoverageAttestation([status], identity, "trace done")
      },
      updated_at: "2026-07-01T00:02:00.000Z"
    });
    const plan = planSessionFold([status, final], identity);
    expect(plan?.status).toBe("ready");
    const generatedRollup = plan!.rollup_record!;
    const rollup = {
      ...generatedRollup,
      content: {
        ...generatedRollup.content,
        memory_retention: metadata({
          layer: "L1",
          lineage: {
            covered_record_ids: plan!.source_record_ids,
            source_digests: Object.fromEntries(plan!.source_digests.map((source) => [source.record_id, source.digest])),
            compression_level: 1,
            coverage_verified: true
          }
        })
      }
    };
    const archivedStatus: MorynRecord = {
      ...status,
      state: "archived",
      visibility: "archived",
      updated_at: "2026-07-01T00:02:00.002Z"
    };

    const verified = buildMemoryRetentionReadModel([archivedStatus, rollup]);
    expect(verified.records_by_id[status.id]).toMatchObject({
      lineage: {
        covered_by_record_ids: [rollup.id],
        coverage_verified: true
      },
      safety: { automatic_purge_safe: true }
    });
    expect(verified.records_by_id[status.id]?.safety.purge_blockers).not.toContain("not_verified_covered");

    const tampered = buildMemoryRetentionReadModel([
      { ...archivedStatus, content: { ...archivedStatus.content, text: "tampered" } },
      rollup
    ]);
    expect(tampered.records_by_id[status.id]).toMatchObject({
      lineage: { covered_by_record_ids: [], coverage_verified: false },
      safety: { automatic_purge_safe: false }
    });
    expect(tampered.records_by_id[status.id]?.safety.purge_blockers).toContain("not_verified_covered");
  });
});
