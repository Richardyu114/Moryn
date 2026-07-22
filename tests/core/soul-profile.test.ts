import { describe, expect, it } from "vitest";
import type {
  CreateSoulProfileRevisionInput,
  SoulClauseInput,
  SoulProfileRevision,
  SoulSubject
} from "../../src/core/soul-profile.js";
import {
  compileEffectiveSoul,
  createSoulClause,
  createSoulProfileRevision,
  estimateSoulTokens,
  parseLegacySoulRecord,
  parseLegacySoulRecords,
  selectLastKnownGoodSoulRevision,
  stableSoulClauseId,
  stableSoulProfileId
} from "../../src/core/soul-profile.js";
import type { MorynRecord } from "../../src/core/types.js";

const userSubject: SoulSubject = { kind: "user", subject_id: "default", display_name: "Owner" };
const agentSubject: SoulSubject = { kind: "agent", subject_id: "moryn-codex", display_name: "Moryn Codex" };

function revision(
  clauses: readonly SoulClauseInput[],
  overrides: Partial<Omit<CreateSoulProfileRevisionInput, "clauses">> = {}
): SoulProfileRevision {
  return createSoulProfileRevision({
    subject: userSubject,
    generation: 1,
    clauses,
    state: "active",
    approved: true,
    approval_receipt_id: "approval-1",
    ...overrides
  });
}

function clause(clauseKey: string, text: string, overrides: Partial<SoulClauseInput> = {}): SoulClauseInput {
  return {
    clause_key: clauseKey,
    category: "collaboration",
    text,
    ...overrides
  };
}

function legacyRecord(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "legacy-soul",
    kind: "soul",
    type: "preference",
    scope: "global",
    tags: [],
    content: { text: "Prefer concise engineering updates." },
    state: "canonical",
    confidence: 1,
    priority: "high",
    visibility: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    source: { client: "user" },
    provenance: { method: "user-confirmed" },
    ...overrides
  };
}

describe("Soul Profile stable identity", () => {
  it("keeps profile and clause identity stable across display and text revisions", () => {
    const firstSubject: SoulSubject = { kind: "agent", subject_id: "primary", display_name: "Codex" };
    const renamedSubject: SoulSubject = { kind: "agent", subject_id: "primary", display_name: "New display name" };
    const profileId = stableSoulProfileId(firstSubject);

    expect(stableSoulProfileId(renamedSubject)).toBe(profileId);
    expect(stableSoulProfileId({ kind: "user", subject_id: "primary" })).not.toBe(profileId);
    expect(stableSoulClauseId(profileId, "tone")).toBe(stableSoulClauseId(profileId, "tone"));
    expect(stableSoulClauseId(profileId, "tone", { kind: "project", project_id: "moryn" })).not.toBe(
      stableSoulClauseId(profileId, "tone")
    );

    const first = createSoulClause(profileId, clause("tone", "Be concise."));
    const revised = createSoulClause(profileId, clause("tone", "Be concise and direct."));
    expect(first.clause_id).toBe(revised.clause_id);
  });

  it("derives revision identity from normalized semantic content, not input order or lifecycle state", () => {
    const inputs = [clause("tone", "Be concise."), clause("proof", "Show evidence.")];
    const active = revision(inputs, { created_at: "2026-07-20T00:00:00.000Z" });
    const draft = revision([...inputs].reverse(), {
      state: "draft",
      approved: false,
      approval_receipt_id: undefined,
      created_at: "2026-07-21T00:00:00.000Z"
    });

    expect(active.revision_id).toBe(draft.revision_id);
    expect(active.clauses.map((item) => item.clause_id)).toEqual(draft.clauses.map((item) => item.clause_id));
    expect(active.revision_id).toMatch(/^soul_revision_[a-f0-9]{24}$/);
  });

  it("forces identity and boundary clauses to be mandatory", () => {
    const profileId = stableSoulProfileId(userSubject);
    expect(
      createSoulClause(profileId, clause("identity", "You are a careful collaborator.", { category: "identity" }))
        .mandatory
    ).toBe(true);
    expect(
      createSoulClause(profileId, clause("boundary", "Never publish without approval.", { category: "boundary" }))
        .mandatory
    ).toBe(true);
    expect(createSoulClause(profileId, clause("tone", "Be concise.")).mandatory).toBe(false);
  });
});

describe("legacy Soul record compatibility", () => {
  it("maps canonical records to approved active v1 revisions", () => {
    const parsed = parseLegacySoulRecord(legacyRecord());

    expect(parsed).toMatchObject({
      schema_version: 1,
      subject: { kind: "user", subject_id: "default" },
      generation: 1,
      state: "active",
      approved: true,
      approval_receipt_id: "legacy-canonical:legacy-soul"
    });
    expect(parsed?.clauses[0]).toMatchObject({
      clause_key: "legacy:legacy-soul",
      category: "collaboration",
      text: "Prefer concise engineering updates.",
      scope: { kind: "global" },
      distribution: "personal_sync",
      priority: 90,
      provenance_record_ids: ["legacy-soul"]
    });
  });

  it("preserves agent subject, project scope, structured fallback text, and private distribution", () => {
    const parsed = parseLegacySoulRecord(
      legacyRecord({
        type: "persona",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { role: "release partner", format: "json" },
        state: "candidate"
      }),
      { subject: agentSubject }
    );

    expect(parsed).toMatchObject({ subject: agentSubject, state: "draft", approved: false });
    expect(parsed?.clauses[0]).toMatchObject({
      category: "identity",
      text: '{"role":"release partner"}',
      scope: { kind: "project", project_id: "moryn" },
      distribution: "local_only",
      mandatory: true
    });
  });

  it("keeps legacy content-level private boundaries local-only", () => {
    const contentPrivate = parseLegacySoulRecord(
      legacyRecord({
        id: "legacy-content-private",
        content: { text: "Device-local preference.", privacy: "private" }
      })
    );
    const localOnly = parseLegacySoulRecord(
      legacyRecord({
        id: "legacy-local-only",
        content: { text: "Host-local preference.", distribution: "local_only" }
      })
    );

    expect(contentPrivate?.clauses[0]?.distribution).toBe("local_only");
    expect(localOnly?.clauses[0]?.distribution).toBe("local_only");
  });

  it("ignores non-Soul records and rejects legacy scopes that v1 cannot express", () => {
    expect(parseLegacySoulRecord(legacyRecord({ kind: "memory" }))).toBeUndefined();
    expect(() => parseLegacySoulRecord(legacyRecord({ scope: "session" }))).toThrow("unsupported scope session");
  });

  it("aggregates multiple canonical records into one deterministic active legacy head", () => {
    const first = legacyRecord({ id: "legacy-a", content: { text: "First preference." } });
    const second = legacyRecord({ id: "legacy-b", content: { text: "Second preference." } });
    const migrated = parseLegacySoulRecords([second, first]);
    const reversed = parseLegacySoulRecords([first, second]);

    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ state: "active", approved: true });
    expect(migrated[0]?.clauses).toHaveLength(2);
    expect(migrated[0]?.revision_id).toBe(reversed[0]?.revision_id);
    const compiled = compileEffectiveSoul({ revisions: migrated });
    expect(compiled.deliverable).toBe(true);
    expect(compiled.clauses.map((item) => item.text).sort()).toEqual(["First preference.", "Second preference."]);
    expect(compiled.conflicts).toEqual([]);
  });
});

describe("last-known-good revision selection", () => {
  it("keeps an older approved active revision when a newer revision is conflicted", () => {
    const good = revision([clause("tone", "Be concise.")]);
    const conflicted = revision([clause("tone", "Be exhaustive.")], {
      generation: 2,
      parent_revision_ids: [good.revision_id],
      state: "conflicted"
    });

    expect(selectLastKnownGoodSoulRevision([conflicted, good], good.profile_id)).toMatchObject({
      status: "using_last_known_good",
      selected_revision: { revision_id: good.revision_id },
      conflicted_revision_ids: [conflicted.revision_id]
    });
  });

  it("does not select draft, candidate, or unapproved active revisions", () => {
    const draft = revision([clause("draft", "Draft behavior")], { state: "draft", approved: true });
    const unapproved = revision([clause("unapproved", "Unapproved behavior")], {
      generation: 2,
      state: "active",
      approved: false
    });
    const selection = selectLastKnownGoodSoulRevision([unapproved, draft], draft.profile_id);

    expect(selection.status).toBe("no_active_revision");
    expect(selection.selected_revision).toBeUndefined();
    expect(selection.ignored_revision_ids).toEqual(
      expect.arrayContaining([
        { revision_id: draft.revision_id, reason: "draft" },
        { revision_id: unapproved.revision_id, reason: "unapproved" }
      ])
    );
  });

  it("falls back below ambiguous concurrent active heads", () => {
    const good = revision([clause("tone", "Be concise.")]);
    const left = revision([clause("tone", "Prefer examples.")], {
      generation: 2,
      parent_revision_ids: [good.revision_id]
    });
    const right = revision([clause("tone", "Prefer tables.")], {
      generation: 2,
      parent_revision_ids: [good.revision_id]
    });
    const selection = selectLastKnownGoodSoulRevision([right, good, left], good.profile_id);

    expect(selection.status).toBe("using_last_known_good");
    expect(selection.selected_revision?.revision_id).toBe(good.revision_id);
    expect(selection.conflicted_revision_ids).toEqual([left.revision_id, right.revision_id].sort());
    expect(selection.ignored_revision_ids.filter((item) => item.reason === "ambiguous_active_head")).toHaveLength(2);
  });

  it("uses DAG heads instead of generation rank for unequal concurrent branches", () => {
    const base = revision([clause("tone", "Use the shared known-good tone.")]);
    const left = revision([clause("tone", "Prefer examples.")], {
      generation: 2,
      parent_revision_ids: [base.revision_id]
    });
    const leftAdvanced = revision([clause("tone", "Prefer examples with evidence.")], {
      generation: 3,
      parent_revision_ids: [left.revision_id]
    });
    const right = revision([clause("tone", "Prefer tables.")], {
      generation: 2,
      parent_revision_ids: [base.revision_id]
    });

    const selection = selectLastKnownGoodSoulRevision([leftAdvanced, right, left, base], base.profile_id);
    const compiled = compileEffectiveSoul({ revisions: [leftAdvanced, right, left, base] });

    expect(selection).toMatchObject({
      status: "using_last_known_good",
      selected_revision: { revision_id: base.revision_id },
      conflicted_revision_ids: [leftAdvanced.revision_id, right.revision_id].sort()
    });
    expect(selection.ignored_revision_ids.filter((item) => item.reason === "ambiguous_active_head")).toEqual(
      expect.arrayContaining([
        { revision_id: leftAdvanced.revision_id, reason: "ambiguous_active_head" },
        { revision_id: right.revision_id, reason: "ambiguous_active_head" }
      ])
    );
    expect(compiled).toMatchObject({ status: "ready_with_omissions", deliverable: true });
    expect(compiled.clauses.map((item) => item.text)).toEqual(["Use the shared known-good tone."]);
  });

  it("selects the nearest common approved ancestor of all active DAG heads", () => {
    const root = revision([clause("tone", "Root tone.")]);
    const shared = revision([clause("tone", "Nearest shared tone.")], {
      generation: 2,
      parent_revision_ids: [root.revision_id]
    });
    const left = revision([clause("tone", "Left tone.")], {
      generation: 3,
      parent_revision_ids: [shared.revision_id]
    });
    const right = revision([clause("tone", "Right tone.")], {
      generation: 9,
      parent_revision_ids: [shared.revision_id]
    });

    const selection = selectLastKnownGoodSoulRevision([right, root, left, shared], root.profile_id);

    expect(selection).toMatchObject({
      status: "using_last_known_good",
      selected_revision: { revision_id: shared.revision_id },
      conflicted_revision_ids: [left.revision_id, right.revision_id].sort()
    });
  });

  it("returns no active revision when concurrent heads have no common approved ancestor", () => {
    const left = revision([clause("tone", "Left root.")]);
    const right = revision([clause("tone", "Right root.")], { generation: 4 });

    const selection = selectLastKnownGoodSoulRevision([right, left], left.profile_id);
    const compiled = compileEffectiveSoul({ revisions: [right, left] });

    expect(selection).toMatchObject({
      status: "no_active_revision",
      conflicted_revision_ids: [left.revision_id, right.revision_id].sort()
    });
    expect(selection.selected_revision).toBeUndefined();
    expect(compiled).toMatchObject({ status: "blocked", deliverable: false, selected_revisions: [] });
    expect(compiled.conflicts).toContainEqual(
      expect.objectContaining({
        kind: "ambiguous_active_head",
        revision_ids: [left.revision_id, right.revision_id].sort()
      })
    );
  });

  it("uses an approved superseded revision as last-known-good below conflicting heads", () => {
    const prior = revision([clause("tone", "Prior safe behavior.")], { state: "superseded" });
    const conflict = revision([clause("tone", "Conflicting behavior.")], {
      generation: 2,
      parent_revision_ids: [prior.revision_id],
      state: "conflicted"
    });
    const selection = selectLastKnownGoodSoulRevision([conflict, prior], prior.profile_id);

    expect(selection).toMatchObject({
      status: "using_last_known_good",
      selected_revision: { revision_id: prior.revision_id, state: "superseded" }
    });
    expect(selection.ignored_revision_ids).not.toContainEqual(
      expect.objectContaining({ revision_id: prior.revision_id })
    );
  });
});

describe("deterministic effective Soul compiler", () => {
  it("loads more than five clauses and produces stable ordering and digests", () => {
    const clauses = Array.from({ length: 8 }, (_, index) =>
      clause(`preference-${index}`, `Preference number ${index}.`, { priority: index })
    );
    const firstRevision = revision(clauses);
    const equivalentRevision = revision([...clauses].reverse());

    const first = compileEffectiveSoul({ revisions: [firstRevision] });
    const second = compileEffectiveSoul({ revisions: [equivalentRevision] });

    expect(first.status).toBe("ready");
    expect(first.clauses).toHaveLength(8);
    expect(first.clauses.map((item) => item.clause_key)).toEqual([
      "preference-7",
      "preference-6",
      "preference-5",
      "preference-4",
      "preference-3",
      "preference-2",
      "preference-1",
      "preference-0"
    ]);
    expect(second.rendered).toBe(first.rendered);
    expect(second.source_digest).toBe(first.source_digest);
    expect(second.rendered_digest).toBe(first.rendered_digest);
    expect(first.source_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.rendered_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("composes user, project, and agent layers by explicit precedence", () => {
    const user = revision([
      clause("tone", "Use the user's global tone."),
      clause("tone", "Use the project-specific tone.", {
        scope: { kind: "project", project_id: "moryn" }
      }),
      clause("approval", "Never push without approval.", { category: "boundary" })
    ]);
    const agent = revision(
      [
        clause("tone", "Use the agent's preferred tone."),
        clause("persona", "Act as the release partner.", { category: "identity" })
      ],
      { subject: agentSubject }
    );

    const compiled = compileEffectiveSoul({
      revisions: [agent, user],
      user_profile_id: user.profile_id,
      agent_profile_id: agent.profile_id,
      project_id: "moryn"
    });

    expect(compiled.clauses.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        "Never push without approval.",
        "Use the project-specific tone.",
        "Act as the release partner."
      ])
    );
    expect(compiled.clauses.map((item) => item.text)).not.toContain("Use the user's global tone.");
    expect(compiled.clauses.map((item) => item.text)).not.toContain("Use the agent's preferred tone.");
    expect(compiled.omissions.filter((item) => item.reason === "overridden")).toHaveLength(2);
  });

  it("filters project scope without affecting global clauses", () => {
    const profile = revision([
      clause("global", "Global behavior."),
      clause("moryn-only", "Moryn project behavior.", { scope: { kind: "project", project_id: "moryn" } }),
      clause("other-only", "Other project behavior.", { scope: { kind: "project", project_id: "other" } })
    ]);
    const compiled = compileEffectiveSoul({ revisions: [profile], project_id: "moryn" });

    expect(compiled.clauses.map((item) => item.text)).toEqual(["Moryn project behavior.", "Global behavior."]);
    expect(compiled.omissions).toContainEqual(
      expect.objectContaining({ clause_key: "other-only", reason: "scope_mismatch" })
    );
  });

  it("rejects project or persona attempts to weaken a protected boundary", () => {
    const profileId = stableSoulProfileId(userSubject);
    const globalBoundary = createSoulClause(
      profileId,
      clause("publishing", "Never publish without explicit approval.", { category: "boundary" })
    );
    const user = revision([
      globalBoundary,
      clause("publishing", "Publishing without approval is fine.", {
        category: "boundary",
        scope: { kind: "project", project_id: "moryn" }
      })
    ]);
    const agent = revision(
      [
        clause("fast-publish", "Publish immediately.", {
          overrides_clause_id: globalBoundary.clause_id
        })
      ],
      { subject: agentSubject }
    );
    const compiled = compileEffectiveSoul({
      revisions: [agent, user],
      user_profile_id: user.profile_id,
      agent_profile_id: agent.profile_id,
      project_id: "moryn"
    });

    expect(compiled.clauses.map((item) => item.text)).toContain("Never publish without explicit approval.");
    expect(compiled.clauses.map((item) => item.text)).not.toContain("Publishing without approval is fine.");
    expect(compiled.clauses.map((item) => item.text)).not.toContain("Publish immediately.");
    expect(compiled.omissions.filter((item) => item.reason === "protected_clause_override")).toHaveLength(2);
    expect(compiled.conflicts.filter((item) => item.kind === "protected_clause_override")).toHaveLength(2);
  });

  it("uses last-known-good content and exposes revision conflict evidence", () => {
    const good = revision([clause("tone", "Known-good tone.")]);
    const conflict = revision([clause("tone", "Conflicted tone.")], {
      generation: 2,
      parent_revision_ids: [good.revision_id],
      state: "conflicted"
    });
    const compiled = compileEffectiveSoul({ revisions: [conflict, good] });

    expect(compiled.clauses.map((item) => item.text)).toEqual(["Known-good tone."]);
    expect(compiled.selections_by_profile_id[good.profile_id]?.status).toBe("using_last_known_good");
    expect(compiled.conflicts).toContainEqual(
      expect.objectContaining({ kind: "revision_conflict", revision_ids: [conflict.revision_id] })
    );
  });

  it("never injects draft or unapproved active profiles", () => {
    const draft = revision([clause("draft", "Do not inject draft.")], { state: "draft" });
    const unapprovedAgent = revision([clause("agent", "Do not inject unapproved persona.")], {
      subject: agentSubject,
      state: "active",
      approved: false
    });
    const compiled = compileEffectiveSoul({
      revisions: [draft, unapprovedAgent],
      user_profile_id: draft.profile_id,
      agent_profile_id: unapprovedAgent.profile_id
    });

    expect(compiled.selected_revisions).toEqual([]);
    expect(compiled.clauses).toEqual([]);
    expect(compiled.rendered).toBe("Moryn Effective Soul v1");
    expect(compiled.rendered).not.toContain("Do not inject");
  });

  it("blocks ambiguous user or Agent profile bindings instead of silently selecting none", () => {
    const firstUser = revision([clause("first", "First user profile.")], {
      subject: { kind: "user", subject_id: "first" }
    });
    const secondUser = revision([clause("second", "Second user profile.")], {
      subject: { kind: "user", subject_id: "second" }
    });
    const firstAgent = revision([clause("first-agent", "First Agent profile.")], {
      subject: { kind: "agent", subject_id: "first" }
    });
    const secondAgent = revision([clause("second-agent", "Second Agent profile.")], {
      subject: { kind: "agent", subject_id: "second" }
    });
    const compiled = compileEffectiveSoul({ revisions: [secondAgent, firstUser, firstAgent, secondUser] });

    expect(compiled.status).toBe("blocked");
    expect(compiled.deliverable).toBe(false);
    expect(compiled.selected_revisions).toEqual([]);
    expect(compiled.conflicts.filter((item) => item.kind === "ambiguous_profile_binding")).toEqual([
      expect.objectContaining({
        profile_id: "unbound:agent",
        profile_ids: [firstAgent.profile_id, secondAgent.profile_id].sort()
      }),
      expect.objectContaining({
        profile_id: "unbound:user",
        profile_ids: [firstUser.profile_id, secondUser.profile_id].sort()
      })
    ]);
  });

  it("blocks explicit profile bindings that are missing or target the wrong subject kind", () => {
    const agent = revision([clause("persona", "Agent persona.", { category: "identity" })], {
      subject: agentSubject
    });

    const missing = compileEffectiveSoul({ revisions: [agent], agent_profile_id: "missing-profile" });
    expect(missing).toMatchObject({ status: "blocked", deliverable: false, selected_revisions: [] });
    expect(missing.conflicts).toContainEqual(
      expect.objectContaining({ kind: "profile_binding_not_found", profile_id: "missing-profile" })
    );

    const wrongSubject = compileEffectiveSoul({ revisions: [agent], user_profile_id: agent.profile_id });
    expect(wrongSubject).toMatchObject({ status: "blocked", deliverable: false });
    expect(wrongSubject.conflicts).toContainEqual(
      expect.objectContaining({ kind: "profile_subject_mismatch", profile_id: agent.profile_id })
    );
  });
});

describe("Soul privacy distribution and budgets", () => {
  it("excludes local-only clauses from a personal-sync projection", () => {
    const profile = revision([
      clause("portable", "Portable preference.", { distribution: "personal_sync" }),
      clause("device", "Only use on this device.", { distribution: "local_only" })
    ]);

    const portable = compileEffectiveSoul({ revisions: [profile], allowed_distributions: ["personal_sync"] });
    const local = compileEffectiveSoul({
      revisions: [profile],
      allowed_distributions: ["personal_sync", "local_only"]
    });

    expect(portable.clauses.map((item) => item.text)).toEqual(["Portable preference."]);
    expect(portable.omissions).toContainEqual(
      expect.objectContaining({ clause_key: "device", reason: "distribution_filtered" })
    );
    expect(local.clauses.map((item) => item.text)).toEqual(["Only use on this device.", "Portable preference."]);
    expect(portable.source_digest).toBe(local.source_digest);
    expect(portable.rendered_digest).not.toBe(local.rendered_digest);
    expect(portable.selected_revisions[0]).not.toHaveProperty("clauses");
    expect(JSON.stringify(portable.selected_revisions)).not.toContain("Only use on this device.");
    expect(portable.selections_by_profile_id[profile.profile_id]?.selected_revision).not.toHaveProperty("clauses");
    expect(JSON.stringify(portable.selections_by_profile_id)).not.toContain("Only use on this device.");
  });

  it("omits optional clauses deterministically while never silently truncating mandatory clauses", () => {
    const profile = revision([
      clause("boundary", "Never delete data without explicit approval.", { category: "boundary" }),
      clause("optional-a", "Optional guidance that consumes delivery budget.", { priority: 90 }),
      clause("optional-b", "Another optional preference.", { priority: 10 })
    ]);
    const mandatoryOnly = compileEffectiveSoul({
      revisions: [profile],
      char_budget: 110,
      token_budget: 1_000
    });

    expect(mandatoryOnly.deliverable).toBe(true);
    expect(mandatoryOnly.clauses.map((item) => item.clause_key)).toContain("boundary");
    expect(mandatoryOnly.omissions.some((item) => item.reason === "char_budget")).toBe(true);
    expect(mandatoryOnly.omissions.some((item) => item.clause_key === "boundary")).toBe(false);
  });

  it("blocks delivery and retains full mandatory text when mandatory clauses exceed either budget", () => {
    const profile = revision([
      clause("identity", "A".repeat(180), { category: "identity" }),
      clause("optional", "Optional clause")
    ]);
    const compiled = compileEffectiveSoul({ revisions: [profile], char_budget: 80, token_budget: 1_000 });

    expect(compiled.status).toBe("blocked");
    expect(compiled.deliverable).toBe(false);
    expect(compiled.budget.mandatory_exceeds_budget).toBe(true);
    expect(compiled.rendered).toContain("A".repeat(180));
    expect(compiled.omissions).toContainEqual(
      expect.objectContaining({ clause_key: "optional", reason: "mandatory_budget_exceeded" })
    );
    expect(compiled.omissions.some((item) => item.clause_key === "identity")).toBe(false);
  });

  it("enforces a deterministic token budget independently of the character budget", () => {
    const profile = revision([
      clause("boundary", "必须保护用户边界", { category: "boundary" }),
      clause("optional", "额外偏好应该被预算过滤")
    ]);
    const mandatoryTokens = estimateSoulTokens(
      compileEffectiveSoul({ revisions: [profile], char_budget: 1_000, token_budget: 1_000 }).rendered.replace(
        /\n- \[user\/collaboration\/global\].*$/,
        ""
      )
    );
    const compiled = compileEffectiveSoul({
      revisions: [profile],
      char_budget: 1_000,
      token_budget: mandatoryTokens + 1
    });

    expect(compiled.clauses.map((item) => item.clause_key)).toContain("boundary");
    expect(compiled.omissions).toContainEqual(
      expect.objectContaining({ clause_key: "optional", reason: "token_budget" })
    );
    expect(estimateSoulTokens(compiled.rendered)).toBe(compiled.budget.tokens_used);
  });

  it("keeps source digest stable while rendered digest changes with delivery budget", () => {
    const profile = revision([
      clause("high", "High-priority preference.", { priority: 100 }),
      clause("low", "Low-priority preference that can be omitted.", { priority: 0 })
    ]);
    const full = compileEffectiveSoul({ revisions: [profile] });
    const bounded = compileEffectiveSoul({ revisions: [profile], char_budget: 90, token_budget: 1_000 });

    expect(full.source_digest).toBe(bounded.source_digest);
    expect(full.rendered_digest).not.toBe(bounded.rendered_digest);
    expect(full.clauses).toHaveLength(2);
    expect(bounded.clauses.length).toBeLessThan(2);
  });
});
