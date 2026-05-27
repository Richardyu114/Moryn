import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";

describe("error envelopes", () => {
  it("classifies sensitive content failures with the documented error code", () => {
    const envelope = toErrorEnvelope(new Error("Sensitive content detected: event must be redacted before append"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SENSITIVE_CONTENT_DETECTED",
        recoverable: true,
        recommended_action: "remove or redact sensitive content before retrying"
      }
    });
  });

  it("classifies stale index failures with the documented error code", () => {
    const envelope = toErrorEnvelope(new Error("Index stale: rebuild derived views before retrying"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INDEX_STALE",
        recoverable: true,
        recommended_action: "run mem rebuild"
      }
    });
  });

  it("classifies invalid replay failures as invalid record history", () => {
    const envelope = toErrorEnvelope(new Error("Invalid replay target for event evt_missing_revision: Record not found: rec_missing"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_RECORD",
        recoverable: true,
        recommended_action: "inspect the reported event or record and rebuild from valid history"
      }
    });
  });
});
