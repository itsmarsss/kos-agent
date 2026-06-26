/**
 * Per-job failure handling: retry a flaky operation a bounded number of times,
 * then give up (skip). Keeps the work queue moving instead of crashing on a
 * transient error.
 */
export interface RetryPolicy {
  retries: number;
  /** Observe each failure (for the runs log), e.g. logging attempt + error. */
  onError?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      policy.onError?.(error, attempt);
    }
  }
  throw lastError;
}
