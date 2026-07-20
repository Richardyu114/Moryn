import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSoulCompilationReceipt, writeSoulCompilationReceipt } from "../../src/core/soul-compilation-receipts.js";
import { compileEffectiveSoul, createSoulProfileRevision } from "../../src/core/soul-profile.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const compiledAt = "2026-07-20T06:00:00.000Z";

function effectiveSoul() {
  const revision = createSoulProfileRevision({
    subject: { kind: "user", subject_id: "primary" },
    generation: 1,
    clauses: [
      {
        clause_key: "boundary",
        category: "boundary",
        text: "Never publish without explicit approval.",
        distribution: "personal_sync"
      },
      {
        clause_key: "optional",
        category: "communication",
        text: "Prefer concise updates.",
        distribution: "personal_sync"
      }
    ],
    state: "active",
    approved: true,
    approval_receipt_id: "user-approved:compile-test",
    created_at: compiledAt
  });
  return compileEffectiveSoul({ revisions: [revision], project_id: "moryn", char_budget: 120 });
}

describe("Soul compilation receipts", () => {
  it("writes one idempotent metadata-only receipt with private permissions", async () => {
    await withInitializedTempStore(async (storePath) => {
      const effective = effectiveSoul();
      const first = await writeSoulCompilationReceipt(storePath, effective, compiledAt);
      const second = await writeSoulCompilationReceipt(storePath, effective, "2026-07-20T06:05:00.000Z");

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.receipt).toEqual(first.receipt);
      expect(first.receipt).toMatchObject({
        status: "ready_with_omissions",
        deliverable: true,
        project_id: "moryn",
        source_digest: effective.source_digest,
        rendered_digest: effective.rendered_digest
      });
      const path = join(storePath, "state", "soul-compilation", `${first.receipt.receipt_id}.json`);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("Never publish");
      expect(raw).not.toContain("Prefer concise");
    });
  });

  it("rejects tampered content and invalid timestamps", async () => {
    await withInitializedTempStore(async (storePath) => {
      const written = await writeSoulCompilationReceipt(storePath, effectiveSoul(), compiledAt);
      const path = join(storePath, "state", "soul-compilation", `${written.receipt.receipt_id}.json`);
      await writeFile(path, `${JSON.stringify({ ...written.receipt, deliverable: false })}\n`, "utf8");
      expect(await readSoulCompilationReceipt(storePath, written.receipt.receipt_id)).toBeUndefined();
      await expect(writeSoulCompilationReceipt(storePath, effectiveSoul(), "not-a-time")).rejects.toThrow(
        "compiled_at"
      );
    });
  });
});
