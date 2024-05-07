/** A failure that will not succeed on retry (bad input, unsupported file, policy rejection). */
export class PermanentJobError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** A transient failure (timeouts, provider outages) that should be retried with backoff. */
export class RetryableJobError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

export function classifyError(err: unknown): { type: string; message: string; retryable: boolean } {
  if (err instanceof PermanentJobError) return { type: err.type, message: err.message, retryable: false };
  if (err instanceof RetryableJobError) return { type: err.type, message: err.message, retryable: true };
  const e = err as Error;
  return { type: e?.name ?? 'Error', message: e?.message ?? String(err), retryable: true };
}
