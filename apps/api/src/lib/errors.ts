/**
 * Errors are serialized as RFC 9457 problem details. `code` is a stable machine
 * readable identifier; `detail` is safe to show to the caller.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>) =>
  new AppError(400, 'bad_request', message, extra);

export const validationError = (errors: { path: string; message: string }[]) =>
  new AppError(422, 'validation_failed', 'The request did not pass validation.', { errors });

export const unauthenticated = (message = 'Sign in to continue.') =>
  new AppError(401, 'unauthenticated', message);

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'forbidden', message);

/** Also used for resources the caller may not see, so existence is never revealed. */
export const notFound = (resource = 'Resource') =>
  new AppError(404, 'not_found', `${resource} not found.`);

export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new AppError(409, 'conflict', message, extra);

export const unprocessable = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(422, code, message, extra);

export const tooManyRequests = (message = 'Rate limit exceeded. Retry later.') =>
  new AppError(429, 'rate_limited', message);
