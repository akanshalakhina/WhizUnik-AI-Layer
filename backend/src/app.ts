import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { AppConfig } from './config';
import { AppError } from './errors';
import { errorHandler, notFoundHandler } from './middleware';
import { createAiRouter } from './routes/ai-assistant';
import { createAuthRouter } from './routes/auth';
import { createRecordsRouter } from './routes/records';
import { AiAssistantService } from './services/ai-assistant.service';
import { createProvider } from './services/ai-provider';
import type { AiProvider } from './services/ai-provider.types';
import { AiSummaryService } from './services/ai-summary.service';
import type { Db } from './types';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  roDb: Db;
  provider?: AiProvider;
  now?: () => Date;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
}

export function createApp(deps: AppDeps): { app: Express; assistant: AiAssistantService; summary: AiSummaryService } {
  const { config, db, roDb } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const provider = deps.provider ?? createProvider(config);

  const assistant = new AiAssistantService({ config, db, roDb, provider, now, logger });
  const summary = new AiSummaryService(assistant);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / server-to-server calls carry no Origin header.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(new AppError('FORBIDDEN', 403, 'Origin not allowed.'));
      },
    }),
  );

  // Brute-force protection: only FAILED sign-in attempts count (20 per 15 minutes per IP). The session check
  // (/api/auth/me) runs on every page load and must never be rate limited.
  if (config.rateLimitEnabled) {
    app.post(
      '/api/auth/login',
      rateLimit({
        windowMs: 15 * 60_000,
        limit: 20,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 429, 'Too many failed sign-in attempts. Please wait a few minutes and try again.')),
      }),
    );
  }

  // The default JSON parser only applies to the small auth payloads; AI routes set their own tighter limits.
  app.use('/api/auth', express.json({ limit: '4kb' }), createAuthRouter(config, db));
  app.use('/api/ai', createAiRouter(config, db, assistant, summary));
  app.use('/api/records', createRecordsRouter(config, db, now));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: now().toISOString() });
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return { app, assistant, summary };
}
