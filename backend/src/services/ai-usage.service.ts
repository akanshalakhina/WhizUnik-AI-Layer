import type { AppConfig } from '../config';
import { AppError } from '../errors';
import type { AuthUser, Db, Role } from '../types';
import { ROLES } from '../types';
import { addDays, istDate, startOfMonth } from '../utils/dates';
import { round2 } from '../utils/money';

/**
 * Usage tracking and limits (spec Task 9).
 * Tracks client, user, question, time, model, tokens, estimated cost and status.
 * Enforces a monthly client limit and a daily per-user limit, with 70% / 90%
 * warnings and a limit-reached response.
 */

/**
 * Statuses that count as a delivered AI request towards the daily / monthly request limits. Provider failures do
 * NOT count (an outage must not lock users out), but their tokens, if any, still count towards the cost.
 */
export const COUNTED_STATUSES = ['success', 'success_empty'] as const;
const COUNTED_SQL = COUNTED_STATUSES.map((s) => `'${s}'`).join(',');

export interface ClientAiSettings {
  clientId: number;
  name: string;
  plan: string;
  aiEnabled: boolean;
  permittedRoles: Role[];
  monthlyCostLimitInr: number;
  monthlyRequestLimit: number;
  dailyUserLimit: number;
}

export function getClientAiSettings(db: Db, clientId: number): ClientAiSettings | null {
  const r = db
    .prepare(
      `SELECT id, name, plan, ai_enabled, ai_permitted_roles, ai_monthly_cost_limit_inr, ai_monthly_request_limit, ai_daily_user_limit
         FROM clients WHERE id = ?`,
    )
    .get(clientId) as
    | { id: number; name: string; plan: string; ai_enabled: number; ai_permitted_roles: string; ai_monthly_cost_limit_inr: number; ai_monthly_request_limit: number; ai_daily_user_limit: number }
    | undefined;
  if (!r) return null;
  let roles: Role[] = [];
  try {
    roles = (JSON.parse(r.ai_permitted_roles) as string[]).filter((x): x is Role => (ROLES as readonly string[]).includes(x));
  } catch {
    roles = [];
  }
  return {
    clientId: r.id,
    name: r.name,
    plan: r.plan,
    aiEnabled: r.ai_enabled === 1,
    permittedRoles: roles,
    monthlyCostLimitInr: r.ai_monthly_cost_limit_inr,
    monthlyRequestLimit: r.ai_monthly_request_limit,
    dailyUserLimit: r.ai_daily_user_limit,
  };
}

export interface SettingsPatch {
  aiEnabled?: boolean;
  permittedRoles?: Role[];
  monthlyCostLimitInr?: number;
  monthlyRequestLimit?: number;
  dailyUserLimit?: number;
}

export function updateClientAiSettings(db: Db, clientId: number, patch: SettingsPatch): ClientAiSettings {
  const cur = getClientAiSettings(db, clientId);
  if (!cur) throw new AppError('NOT_FOUND', 404, 'Client not found.');
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE clients SET ai_enabled = ?, ai_permitted_roles = ?, ai_monthly_cost_limit_inr = ?, ai_monthly_request_limit = ?, ai_daily_user_limit = ? WHERE id = ?`,
  ).run(next.aiEnabled ? 1 : 0, JSON.stringify(next.permittedRoles), next.monthlyCostLimitInr, next.monthlyRequestLimit, next.dailyUserLimit, clientId);
  return getClientAiSettings(db, clientId)!;
}

// --------------------------------------------------------------------- cost

export function estimateCostInr(cfg: AppConfig, model: string, inputTokens: number, outputTokens: number): number {
  const table = cfg.ai.pricing;
  let price = table[model];
  if (!price) {
    const key = Object.keys(table).find((k) => model.startsWith(k));
    price = key ? table[key] : table[cfg.ai.modelStrong]; // unknown model: assume the dearer price
  }
  if (!price) return 0;
  return Math.round(((inputTokens / 1_000_000) * price.inputInrPerM + (outputTokens / 1_000_000) * price.outputInrPerM) * 10_000) / 10_000;
}

// ------------------------------------------------------------------- status

export type UsageLevel = 'ok' | 'warning_70' | 'warning_90' | 'limit_reached';

export interface UsageStatus {
  level: UsageLevel;
  dailyLevel: UsageLevel;
  dailyPct: number;
  monthlyPct: number;
  costUsedInr: number;
  costLimitInr: number;
  requestsUsed: number;
  requestLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  message?: string;
}

export function levelFor(pct: number): UsageLevel {
  if (pct >= 100) return 'limit_reached';
  if (pct >= 90) return 'warning_90';
  if (pct >= 70) return 'warning_70';
  return 'ok';
}

export function computeUsageStatus(db: Db, settings: ClientAiSettings, userId: number, now: Date): UsageStatus {
  const today = istDate(now);
  const monthStart = startOfMonth(today);
  const m = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN (${COUNTED_SQL}) THEN 1 ELSE 0 END),0) AS n, COALESCE(SUM(est_cost_inr),0) AS cost FROM ai_usage
        WHERE client_id = ? AND usage_date >= ? AND usage_date <= ?`,
    )
    .get(settings.clientId, monthStart, today) as { n: number; cost: number };
  const d = db
    .prepare(`SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND client_id = ? AND usage_date = ? AND status IN (${COUNTED_SQL})`)
    .get(userId, settings.clientId, today) as { n: number };

  const costPct = settings.monthlyCostLimitInr > 0 ? (m.cost / settings.monthlyCostLimitInr) * 100 : 0;
  const reqPct = settings.monthlyRequestLimit > 0 ? (m.n / settings.monthlyRequestLimit) * 100 : 0;
  const pct = Math.round(Math.max(costPct, reqPct) * 10) / 10;
  const level = levelFor(pct);
  const dailyPct = settings.dailyUserLimit > 0 ? Math.round((d.n / settings.dailyUserLimit) * 1000) / 10 : 100;
  const message =
    level === 'limit_reached'
      ? 'Your company has reached its monthly AI usage limit.'
      : level === 'warning_90'
        ? 'Your company has used over 90% of its monthly AI usage limit.'
        : level === 'warning_70'
          ? 'Your company has used over 70% of its monthly AI usage limit.'
          : undefined;
  return {
    level,
    dailyLevel: levelFor(dailyPct),
    dailyPct,
    monthlyPct: pct,
    costUsedInr: round2(m.cost),
    costLimitInr: settings.monthlyCostLimitInr,
    requestsUsed: m.n,
    requestLimit: settings.monthlyRequestLimit,
    dailyUsed: d.n,
    dailyLimit: settings.dailyUserLimit,
    message,
  };
}

/** Throws the "limit reached" responses. Called before any provider call is made. */
export function assertWithinLimits(status: UsageStatus): void {
  if (status.level === 'limit_reached') {
    throw new AppError('MONTHLY_LIMIT_REACHED', 429, 'Your company has reached its monthly AI usage limit. Please contact your administrator or upgrade the plan. Normal WhizUnik workflows are not affected.', { usage: status });
  }
  if (status.dailyUsed >= status.dailyLimit) {
    throw new AppError('DAILY_LIMIT_REACHED', 429, `You have reached your daily AI limit (${status.dailyLimit} requests). It resets tomorrow. Normal WhizUnik workflows are not affected.`, { usage: status });
  }
}

// ------------------------------------------------------------------- record

export interface UsageRecord {
  clientId: number;
  userId: number;
  requestId: string;
  kind: 'ask' | 'summary';
  question: string; // already redacted by the caller
  now: Date;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estCostInr: number;
  status: string;
}

export function recordUsage(db: Db, r: UsageRecord): void {
  db.prepare(
    `INSERT INTO ai_usage (client_id, user_id, request_id, kind, question, created_at, usage_date, model, provider, input_tokens, output_tokens, est_cost_inr, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(r.clientId, r.userId, r.requestId, r.kind, r.question.slice(0, 500), r.now.toISOString(), istDate(r.now), r.model, r.provider, r.inputTokens, r.outputTokens, r.estCostInr, r.status);
}

// ---------------------------------------------------------------- dashboard

export function usageDashboard(db: Db, settings: ClientAiSettings, user: AuthUser, now: Date) {
  const scope: 'client' | 'self' = user.role === 'management' ? 'client' : 'self';
  const today = istDate(now);
  const monthStart = startOfMonth(today);
  const where = scope === 'client' ? 'u.client_id = ?' : 'u.client_id = ? AND u.user_id = ?';
  const args = (...extra: unknown[]) => (scope === 'client' ? [settings.clientId, ...extra] : [settings.clientId, user.id, ...extra]);

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN (${COUNTED_SQL}) THEN 1 ELSE 0 END),0) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(est_cost_inr),0) AS costInr
         FROM ai_usage u WHERE ${where} AND usage_date >= ? AND usage_date <= ?`,
    )
    .get(...args(monthStart, today)) as { requests: number; inputTokens: number; outputTokens: number; costInr: number };

  const dailyRows = db
    .prepare(
      `SELECT usage_date AS date, COALESCE(SUM(CASE WHEN status IN (${COUNTED_SQL}) THEN 1 ELSE 0 END),0) AS requests, COALESCE(SUM(est_cost_inr),0) AS costInr
         FROM ai_usage u WHERE ${where} AND usage_date >= ? AND usage_date <= ?
        GROUP BY usage_date`,
    )
    .all(...args(addDays(today, -29), today)) as { date: string; requests: number; costInr: number }[];
  const byDate = new Map(dailyRows.map((r) => [r.date, r]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(today, -29 + i);
    const r = byDate.get(date);
    return { date, requests: r?.requests ?? 0, costInr: round2(r?.costInr ?? 0) };
  });

  const byUser =
    scope === 'client'
      ? (db
          .prepare(
            `SELECT usr.id AS userId, usr.name, usr.role, COALESCE(SUM(CASE WHEN u.status IN (${COUNTED_SQL}) THEN 1 ELSE 0 END),0) AS requests, COALESCE(SUM(u.est_cost_inr),0) AS costInr,
                    COALESCE(SUM(u.input_tokens + u.output_tokens),0) AS tokens
               FROM ai_usage u JOIN users usr ON usr.id = u.user_id
              WHERE u.client_id = ? AND u.usage_date >= ? AND u.usage_date <= ?
              GROUP BY usr.id HAVING requests > 0 OR tokens > 0 ORDER BY requests DESC`,
          )
          .all(settings.clientId, monthStart, today) as { userId: number; name: string; role: string; requests: number; costInr: number; tokens: number }[])
      : [];

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(est_cost_inr),0) AS costInr
         FROM ai_usage u WHERE ${where} AND usage_date >= ? AND usage_date <= ? AND (status IN (${COUNTED_SQL}) OR input_tokens + output_tokens > 0) GROUP BY model ORDER BY requests DESC`,
    )
    .all(...args(monthStart, today)) as { model: string; requests: number; inputTokens: number; outputTokens: number; costInr: number }[];

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS requests FROM ai_usage u WHERE ${where} AND usage_date >= ? AND usage_date <= ? GROUP BY status ORDER BY requests DESC`)
    .all(...args(monthStart, today)) as { status: string; requests: number }[];

  const recent = db
    .prepare(
      `SELECT u.created_at AS createdAt, usr.name AS user, u.kind, u.question, u.model, u.input_tokens AS inputTokens,
              u.output_tokens AS outputTokens, u.est_cost_inr AS costInr, u.status
         FROM ai_usage u JOIN users usr ON usr.id = u.user_id
        WHERE ${where} ORDER BY u.id DESC LIMIT 25`,
    )
    .all(...args()) as Record<string, unknown>[];

  return {
    scope,
    month: today.slice(0, 7),
    status: computeUsageStatus(db, settings, user.id, now),
    limits: {
      monthlyCostLimitInr: settings.monthlyCostLimitInr,
      monthlyRequestLimit: settings.monthlyRequestLimit,
      dailyUserLimit: settings.dailyUserLimit,
    },
    totals: { ...totals, costInr: round2(totals.costInr) },
    daily,
    byUser: byUser.map((u) => ({ ...u, costInr: round2(u.costInr) })),
    byModel: byModel.map((m) => ({ ...m, costInr: round2(m.costInr) })),
    byStatus,
    recent,
    note: 'Costs are ESTIMATES based on configured per-token prices; check the provider invoice for actual charges.',
  };
}
