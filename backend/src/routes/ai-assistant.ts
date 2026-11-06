import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppConfig } from '../config';
import { AppError } from '../errors';
import { authenticate, requireRole } from '../middleware';
import { listAudit, clearHistory, getHistoryEntry, listHistory } from '../services/ai-audit.service';
import { AiAssistantService, SAMPLE_QUESTIONS } from '../services/ai-assistant.service';
import { AiSummaryService } from '../services/ai-summary.service';
import { permissionMatrix, ROLE_DESCRIPTIONS, toolsForRole } from '../services/ai-permissions.service';
import { getClientAiSettings, usageDashboard, computeUsageStatus } from '../services/ai-usage.service';
import type { Db } from '../types';

/**
 * AI routes (spec Task 3).
 *   POST /api/ai/ask          natural-language question -> structured answer
 *   GET  /api/ai/summary      AI Management Summary panel
 *   GET  /api/ai/status       feature state for the signed-in user
 *   GET  /api/ai/history      current user's search history
 *   GET  /api/ai/usage        usage dashboard
 *   GET  /api/ai/audit        audit log (management)
 *   GET  /api/ai/settings     feature flag, limits, permitted roles (management, read-only; changed by the operator
 *                             with `npm run ai:configure` so a client cannot raise its own limits)
 *   GET  /api/ai/health       provider connection test (management)
 */
export function createAiRouter(cfg: AppConfig, db: Db, svc: AiAssistantService, summary: AiSummaryService): Router {
  const router = Router();
  router.use(authenticate(cfg, db));

  const limiter = cfg.rateLimitEnabled
    ? rateLimit({
        windowMs: 60_000,
        limit: 40,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => `u${req.user?.id ?? 'anon'}`,
        handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 429, 'Too many AI requests. Please slow down and try again in a minute.')),
      })
    : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

  // Small body limit: a question is at most a few hundred characters.
  router.post('/ask', limiter, express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      // No schema here on purpose: any missing / non-string question is reported as INVALID_QUESTION (400) by the service.
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { question?: unknown };
      const result = await svc.ask(req.user!, body.question);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.get('/summary', limiter, async (req, res, next) => {
    try {
      res.json(await summary.getSummary(req.user!, req.query.refresh === 'true' || req.query.refresh === '1'));
    } catch (e) {
      next(e);
    }
  });

  router.get('/status', (req, res, next) => {
    try {
      const u = req.user!;
      const settings = getClientAiSettings(db, u.clientId);
      const enabled = cfg.ai.enabled && !!settings?.aiEnabled;
      const roleAllowed = enabled && !!settings?.permittedRoles.includes(u.role);
      res.json({
        enabled,
        roleAllowed,
        reason: !enabled ? 'AI is not enabled for your company.' : !roleAllowed ? `AI is not enabled for the ${ROLE_DESCRIPTIONS[u.role].label} role.` : null,
        provider: svc.provider.name,
        role: u.role,
        roleLabel: ROLE_DESCRIPTIONS[u.role].label,
        roleAccess: ROLE_DESCRIPTIONS[u.role].access,
        allowedTools: toolsForRole(u.role),
        sampleQuestions: SAMPLE_QUESTIONS[u.role] ?? [],
        usage: settings ? computeUsageStatus(db, settings, u.id, svc.now()) : null,
        advisoryOnly: true,
      });
    } catch (e) {
      next(e);
    }
  });

  // Stored answers are only readable while AI is enabled for the company and the user's role.
  router.get('/history', (req, res, next) => {
    try {
      svc.requireEnabled(req.user!);
      res.json({ items: listHistory(db, req.user!.clientId, req.user!.id) });
    } catch (e) {
      next(e);
    }
  });
  router.get('/history/:id', (req, res, next) => {
    try {
      svc.requireEnabled(req.user!);
      const entry = getHistoryEntry(db, req.user!.clientId, req.user!.id, Number(req.params.id));
      if (!entry) throw new AppError('NOT_FOUND', 404, 'History entry not found.');
      res.json(entry);
    } catch (e) {
      next(e);
    }
  });
  router.delete('/history', (req, res) => {
    res.json({ deleted: clearHistory(db, req.user!.clientId, req.user!.id) });
  });

  router.get('/usage', (req, res, next) => {
    try {
      const settings = getClientAiSettings(db, req.user!.clientId);
      if (!settings) throw new AppError('NOT_FOUND', 404, 'Client not found.');
      res.json(usageDashboard(db, settings, req.user!, svc.now()));
    } catch (e) {
      next(e);
    }
  });

  router.get('/audit', requireRole('management'), (req, res) => {
    res.json({ items: listAudit(db, req.user!.clientId, Number(req.query.limit) || 100) });
  });

  router.get('/permissions', (req, res) => {
    const u = req.user!;
    res.json(u.role === 'management' ? permissionMatrix() : { roles: { [u.role]: ROLE_DESCRIPTIONS[u.role] }, tools: toolsForRole(u.role) });
  });

  router.get('/settings', requireRole('management'), (req, res, next) => {
    try {
      const s = getClientAiSettings(db, req.user!.clientId);
      if (!s) throw new AppError('NOT_FOUND', 404, 'Client not found.');
      res.json({
        ...s,
        editable: false,
        changedBy: 'your WhizUnik administrator (operator command: npm run ai:configure)',
        globalAiEnabled: cfg.ai.enabled,
        provider: svc.provider.name,
        models: { fast: cfg.ai.modelFast, strong: cfg.ai.modelStrong },
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/health', requireRole('management'), async (_req, res, next) => {
    try {
      res.json(await svc.provider.testConnection());
    } catch (e) {
      next(e);
    }
  });

  return router;
}
