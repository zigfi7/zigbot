import type { AuthProfileFailureReason } from "./types.js";

const QUOTA_EXHAUSTED_HINTS = [
  // Common Gemini wording
  "exceeded your current quota",
  "quota exceeded",
  "insufficient quota",
] as const;

/**
 * Some providers (notably Google/Gemini) return quota-exhausted errors as 429/rate_limit.
 * For free-tier keys, retrying quickly is wasteful; treat these as "billing" so the
 * profile is disabled (long backoff) rather than put into a short cooldown.
 */
export function resolveAuthProfileFailureReasonForRotation(params: {
  reason: AuthProfileFailureReason;
  errorMessage?: string;
}): AuthProfileFailureReason {
  if (params.reason !== "rate_limit") {
    return params.reason;
  }
  const raw = params.errorMessage?.toLowerCase() ?? "";
  if (!raw) {
    return params.reason;
  }
  if (QUOTA_EXHAUSTED_HINTS.some((hint) => raw.includes(hint))) {
    return "billing";
  }
  return params.reason;
}
