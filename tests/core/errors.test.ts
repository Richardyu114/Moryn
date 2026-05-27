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
});
