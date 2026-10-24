/**
 * Exponential backoff with full jitter (AWS "Exponential Backoff and Jitter" —
 * full jitter avoids retry storms across a fleet of agents after a SaaS blip).
 * Pure: the RNG is injected for deterministic tests.
 */
export interface RetryPolicy {
  /** Delay before the first retry. */
  readonly baseDelayMs: number;
  /** Upper bound — retries never wait longer than this. */
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 4,
};

/** attempt is 1-based (the retry number, not the original request). */
export function nextBackoffMs(policy: RetryPolicy, attempt: number, random: () => number): number {
  const capped = Math.min(attempt, 30);
  const exponential = Math.min(policy.baseDelayMs * 2 ** (capped - 1), policy.maxDelayMs);
  return Math.floor(random() * exponential);
}
