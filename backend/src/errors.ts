/** Typed application error, rendered as `{ error: { code, message, ... } }` by the error middleware. */
export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_QUESTION'
  | 'INVALID_REQUEST'
  | 'AI_DISABLED'
  | 'ROLE_NOT_PERMITTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'MONTHLY_LIMIT_REACHED'
  | 'DAILY_LIMIT_REACHED'
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_PROVIDER_AUTH'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_RATE_LIMIT'
  | 'AI_PROVIDER_OUTAGE'
  | 'AI_MALFORMED_RESPONSE'
  | 'UNAUTHORISED_TOOL'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}
