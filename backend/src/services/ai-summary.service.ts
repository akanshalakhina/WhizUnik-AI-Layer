import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AuthUser, Role, ToolName } from '../types';
import { istDate } from '../utils/dates';
import { recordAudit } from './ai-audit.service';
import { assembleAnswer, toAppError } from './ai-assistant.service';
import type { AiAssistantService, ResponseAction, ResponseItem } from './ai-assistant.service';
import type { Figure, ToolItem, ToolParams, ToolResult } from './ai-data-tools.service';
import { canUseTool } from './ai-permissions.service';
import type { AnswerContext } from './ai-provider.types';
import { composeLocalAnswer } from './ai-provider.local';
import { ProviderError } from './ai-provider.types';
import { redactSensitive } from './ai-safety.service';
import { computeUsageStatus, estimateCostInr, getClientAiSettings, recordUsage } from './ai-usage.service';
import type { UsageStatus } from './ai-usage.service';
import { AppError } from '../errors';

/**
 * "AI Management Summary" dashboard panel (spec section 9 / Task 7).
 *
 * The section lists (sales risks, stock risks, ...) are built from approved
 * data-tool results only, so every line traces to a WhizUnik record. The model
 * only writes the short overview and the recommended next actions, and every
 * action must cite a retrieved record.
 */

export interface SummarySection {
  key: string;
  title: string;
  restricted: boolean;
  total: number;
  high: number;
  items: ResponseItem[];
}

export interface SummaryResponse {
  requestId: string;
  date: string;
  role: Role;
  generatedAt: string;
  expiresAt: string;
  cached: boolean;
  degraded: boolean;
  aiNotice?: string;
  overview: string;
  sections: SummarySection[];
  recommendedActions: ResponseAction[];
  figures: Figure[];
  assumptions: string[];
  missingData: string[];
  warnings: string[];
  usage: { inputTokens: number; outputTokens: number; estimatedCostInr: number; model: string; provider: string };
  usageStatus: UsageStatus;
}

interface SectionDef {
  key: string;
  title: string;
  tool: ToolName;
  params: ToolParams;
  from: string[];
  keep?: (i: ToolItem) => boolean;
  also?: { tool: ToolName; params: ToolParams; from: string[]; keep?: (i: ToolItem) => boolean };
}

const DEFS: SectionDef[] = [
  { key: 'salesRisks', title: 'Sales risks', tool: 'getOpenSalesOrders', params: {}, from: ['orders'], keep: (i) => i.flags.some((f) => f !== 'high_value') },
  { key: 'stockRisks', title: 'Stock risks', tool: 'getLowStockProducts', params: { focus: 'stockout', horizonDays: 14 }, from: ['stockOutRisk'] },
  { key: 'procurementDelays', title: 'Procurement delays', tool: 'getDelayedPurchaseOrders', params: {}, from: ['delayedPos'] },
  {
    key: 'overduePayments',
    title: 'Overdue payments',
    tool: 'getOverdueInvoices',
    params: {},
    from: ['invoices'],
    also: { tool: 'getCashFlowSummary', params: {}, from: ['payables'], keep: (i) => i.flags.includes('overdue_payable') },
  },
  { key: 'warehouseDelays', title: 'Warehouse delays', tool: 'getPendingWarehouseTasks', params: {}, from: ['tasks'], keep: (i) => i.flags.includes('overdue') },
  {
    key: 'marketplaceExceptions',
    title: 'Marketplace exceptions',
    tool: 'getMarketplaceExceptions',
    params: {},
    from: ['unmappedSkus', 'waitingForStock', 'waitingForInvoice', 'apiFailures', 'settlementDifferences'],
  },
  { key: 'approvals', title: 'Pending approvals', tool: 'getPendingApprovals', params: {}, from: ['approvals'] },
];

const SEV_RANK = { high: 3, medium: 2, low: 1 } as const;
const ITEMS_PER_SECTION = 5;

function pickItems(results: ToolResult[], tool: ToolName, from: string[], keep?: (i: ToolItem) => boolean): ToolItem[] {
  const r = results.find((x) => x.tool === tool);
  if (!r) return [];
  const seen = new Set<string>();
  const out: ToolItem[] = [];
  for (const s of r.sections.filter((s) => from.includes(s.key))) {
    for (const i of s.items) {
      if ((keep && !keep(i)) || seen.has(i.ref)) continue;
      seen.add(i.ref);
      out.push(i);
    }
  }
  return out;
}

export class AiSummaryService {
  constructor(private readonly svc: AiAssistantService) {}

  async getSummary(user: AuthUser, refresh: boolean): Promise<SummaryResponse> {
    const started = performance.now();
    const requestId = randomUUID();
    const now = this.svc.now();
    const today = istDate(now);
    const settings = this.svc.requireEnabled(user);
    const db = this.svc.db;

    // ---- cached daily summary (no provider call, no cost)
    if (!refresh) {
      const row = db
        .prepare('SELECT payload FROM ai_summary_cache WHERE client_id = ? AND role = ? AND summary_date = ?')
        .get(user.clientId, user.role, today) as { payload: string } | undefined;
      if (row) {
        const cached = JSON.parse(row.payload) as SummaryResponse;
        if (Date.parse(cached.expiresAt) > now.getTime()) {
          this.audit(user, requestId, 'cached', [], null, started, 0, 0, []);
          return { ...cached, cached: true, usageStatus: computeUsageStatus(db, settings, user.id, now) };
        }
      }
    }

    // ---- gather data through the approved tools the role may use
    const calls: { tool: ToolName; params: ToolParams }[] = [];
    for (const d of DEFS) {
      if (canUseTool(user.role, d.tool)) calls.push({ tool: d.tool, params: d.params });
      if (d.also && canUseTool(user.role, d.also.tool)) calls.push({ tool: d.also.tool, params: d.also.params });
    }
    const results = this.svc.runTools(user, 'management', calls, 10);

    const sections: SummarySection[] = DEFS.map((d) => {
      const allowed = canUseTool(user.role, d.tool);
      if (!allowed) return { key: d.key, title: d.title, restricted: true, total: 0, high: 0, items: [] };
      const picked = [...pickItems(results, d.tool, d.from, d.keep), ...(d.also ? pickItems(results, d.also.tool, d.also.from, d.also.keep) : [])].sort(
        (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity],
      );
      return {
        key: d.key,
        title: d.title,
        restricted: false,
        total: picked.length,
        high: picked.filter((i) => i.severity === 'high').length,
        items: picked.slice(0, ITEMS_PER_SECTION).map((i) => ({ ref: i.ref, title: i.title, detail: i.detail, severity: i.severity, source: i.source })),
      };
    });

    const ctx: AnswerContext = {
      mode: 'summary',
      question: 'AI Management Summary',
      category: 'management',
      role: user.role,
      today,
      period: { from: today, to: today, description: `As of today (${today})` },
      toolResults: results,
      blockedByRole: [],
    };

    // ---- AI overview + recommendations (degrades gracefully; never blocks the dashboard)
    const acc = { inputTokens: 0, outputTokens: 0, model: 'none' };
    const flags: string[] = [];
    let degraded = false;
    let aiNotice: string | undefined;
    let status = 'success';
    let asm;
    const usageBefore = computeUsageStatus(db, settings, user.id, now);
    const model = this.svc.selectModel(user.role === 'management');
    try {
      if (usageBefore.level === 'limit_reached') throw new AppError('MONTHLY_LIMIT_REACHED', 429, 'Your company has reached its monthly AI usage limit.');
      if (usageBefore.dailyUsed >= usageBefore.dailyLimit) throw new AppError('DAILY_LIMIT_REACHED', 429, 'You have reached your daily AI limit.');
      const pa = await this.svc.callModel(ctx, model, acc, flags);
      asm = assembleAnswer(ctx, pa);
    } catch (e) {
      const err = toAppError(e, this.svc.logger);
      if (e instanceof ProviderError) {
        flags.push(`provider:${e.code}`);
        this.svc.logger.warn(`[ai] provider error ${e.code} (client ${user.clientId}, summary)`);
      }
      degraded = true;
      aiNotice = `${err.message} Showing the data-only summary.`;
      status = err.code === 'MONTHLY_LIMIT_REACHED' || err.code === 'DAILY_LIMIT_REACHED' ? 'blocked_limit' : 'provider_error';
      asm = assembleAnswer(ctx, composeLocalAnswer(ctx));
    }
    flags.push(...asm.flags);

    const cost = estimateCostInr(this.svc.cfg, acc.model, acc.inputTokens, acc.outputTokens);
    try {
      recordUsage(db, {
        clientId: user.clientId,
        userId: user.id,
        requestId,
        kind: 'summary',
        question: 'AI Management Summary',
        now,
        model: acc.model !== 'none' ? acc.model : model,
        provider: this.svc.provider.name,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        estCostInr: cost,
        status,
      });
    } catch (e) {
      this.svc.logger.error('[ai] failed to record summary usage', redactSensitive(String(e)));
    }
    this.audit(user, requestId, status, calls.map((c) => c.tool), acc.model !== 'none' ? acc.model : model, started, acc.inputTokens, acc.outputTokens, flags, cost);

    const ttlMin = degraded ? 5 : this.svc.cfg.ai.summaryCacheMinutes;
    const payload: SummaryResponse = {
      requestId,
      date: today,
      role: user.role,
      generatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
      cached: false,
      degraded,
      aiNotice,
      overview: asm.answer,
      sections,
      recommendedActions: asm.recommendedActions.slice(0, 6),
      figures: this.headlineFigures(results),
      assumptions: asm.assumptions.slice(0, 6),
      missingData: asm.missingData,
      warnings: asm.warnings,
      usage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, estimatedCostInr: cost, model: acc.model, provider: this.svc.provider.name },
      usageStatus: computeUsageStatus(db, getClientAiSettings(db, user.clientId) ?? settings, user.id, now),
    };
    try {
      db.prepare(
        `INSERT INTO ai_summary_cache (client_id, role, summary_date, generated_at, payload) VALUES (?,?,?,?,?)
         ON CONFLICT(client_id, role, summary_date) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload`,
      ).run(user.clientId, user.role, today, payload.generatedAt, JSON.stringify(payload));
    } catch (e) {
      this.svc.logger.error('[ai] failed to cache summary', redactSensitive(String(e)));
    }
    return payload;
  }

  private headlineFigures(results: ToolResult[]): Figure[] {
    // [tool, exact figure label produced by the tool, label shown on the panel]
    const pick: [ToolName, string, string][] = [
      ['getOpenSalesOrders', 'Orders needing attention', 'Sales orders needing attention'],
      ['getLowStockProducts', 'SKUs at risk of stock-out within 14 days', 'SKUs at stock-out risk (14 days)'],
      ['getDelayedPurchaseOrders', 'Delayed purchase orders', 'Delayed purchase orders'],
      ['getOverdueInvoices', 'Total overdue (outstanding balance)', 'Overdue receivables'],
      ['getPendingWarehouseTasks', 'Overdue tasks', 'Overdue warehouse tasks'],
      ['getMarketplaceExceptions', 'Blocked marketplace orders (total)', 'Blocked marketplace orders'],
      ['getPendingApprovals', 'Pending approvals and exceptions', 'Pending approvals'],
    ];
    const out: Figure[] = [];
    for (const [tool, label, display] of pick) {
      const f = results.find((r) => r.tool === tool)?.figures.find((x) => x.label === label);
      if (f) out.push({ label: display, value: f.value });
    }
    return out;
  }

  private audit(user: AuthUser, requestId: string, status: string, tools: string[], model: string | null, started: number, inTok: number, outTok: number, flags: string[], cost = 0): void {
    try {
      recordAudit(this.svc.db, {
        requestId,
        now: this.svc.now(),
        clientId: user.clientId,
        userId: user.id,
        role: user.role,
        category: 'management',
        toolsUsed: tools,
        model,
        provider: this.svc.provider.name,
        status,
        processingMs: performance.now() - started,
        inputTokens: inTok,
        outputTokens: outTok,
        estCostInr: cost,
        flags: [...new Set(flags)],
      });
    } catch (e) {
      this.svc.logger.error('[ai] failed to write summary audit log', redactSensitive(String(e)));
    }
  }
}
