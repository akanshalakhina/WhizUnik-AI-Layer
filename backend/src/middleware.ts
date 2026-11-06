import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import { AppError } from './errors';
import type { AuthUser, Db, Role } from './types';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export interface TokenPayload {
  sub: number;
}

export function signToken(cfg: AppConfig, userId: number): string {
  return jwt.sign({ sub: userId } satisfies TokenPayload, cfg.jwtSecret, { expiresIn: cfg.jwtExpiresIn } as jwt.SignOptions);
}

/**
 * Authentication. The user's role and client are always re-read from the
 * database, so a token can never be used to claim a different client or role.
 */
export function authenticate(cfg: AppConfig, db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(new AppError('UNAUTHENTICATED', 401, 'Authentication is required.'));
    try {
      const payload = jwt.verify(header.slice(7), cfg.jwtSecret) as unknown as TokenPayload;
      const row = db
        .prepare('SELECT id, client_id, name, email, role FROM users WHERE id = ? AND active = 1')
        .get(payload.sub) as { id: number; client_id: number; name: string; email: string; role: Role } | undefined;
      if (!row) return next(new AppError('UNAUTHENTICATED', 401, 'Your session is no longer valid. Please sign in again.'));
      req.user = { id: row.id, clientId: row.client_id, name: row.name, email: row.email, role: row.role };
      next();
    } catch {
      next(new AppError('UNAUTHENTICATED', 401, 'Your session has expired or is invalid. Please sign in again.'));
    }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 401, 'Authentication is required.'));
    if (!roles.includes(req.user.role)) return next(new AppError('FORBIDDEN', 403, 'Your role is not permitted to do this.'));
    next();
  };
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError('NOT_FOUND', 404, 'Route not found.'));
}

/** Uniform error responses. Internal details are logged, never sent to the client. */
export function errorHandler(logger: Pick<Console, 'error'> = console) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (typeof err.extra.retryAfterSec === 'number') res.setHeader('Retry-After', String(err.extra.retryAfterSec));
      const { fallback, ...safeExtra } = err.extra as { fallback?: unknown } & Record<string, unknown>;
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...safeExtra }, ...(fallback ? { fallback } : {}) });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'INVALID_REQUEST', message: 'The request body is too large.' } });
    if (e?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The request body is not valid JSON.' } });
    }
    logger.error('[http] unhandled error', err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  };
}
