import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReasonForRotation } from "./rotation.js";

describe("auth-profiles rotation reason mapping", () => {
  it("treats quota-exhausted rate limits as billing (disabled)", () => {
    expect(
      resolveAuthProfileFailureReasonForRotation({
        reason: "rate_limit",
        errorMessage: "429: exceeded your current quota for this API key",
      }),
    ).toBe("billing");
  });

  it("keeps normal rate limits as rate_limit", () => {
    expect(
      resolveAuthProfileFailureReasonForRotation({
        reason: "rate_limit",
        errorMessage: "429 too many requests",
      }),
    ).toBe("rate_limit");
  });

  it("does not rewrite non-rate_limit reasons", () => {
    expect(
      resolveAuthProfileFailureReasonForRotation({
        reason: "auth",
        errorMessage: "quota exceeded",
      }),
    ).toBe("auth");
  });
});
