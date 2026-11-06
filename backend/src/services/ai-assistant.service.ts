import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AppConfig } from '../config';
import { AppError } from '../errors';
import type { AuthUser, Category, Db, Severity, SourceRef, ToolName } from '../types';
import { istDate } from '../utils/dates';
import { recordAudit, saveHistory } from './ai-audit.service';
import { classifyQuestion, isComplexQuestion, selectTools } from './ai-classifier.service';
import type { Classification } from './ai-classifier.service';
import { runTool } from './ai-data-tools.service';
import type { Figure, ToolContext, ToolItem, ToolResult } from './ai-data-tools.service';
import { ROLE_DESCRIPTIONS, TOOL_LABELS, TOOL_PERMISSIONS, ToolGate, toolsForRole } from './ai-permissions.service';
import { buildUserPrompt, SYSTEM_PROMPT } from './ai-prompt';
import { composeLocalAnswer } from './ai-provider.local';
import type { AiProvider, AnswerContext } from './ai-provider.types';
import { ProviderError } from './ai-provider.types';
import {
  ADVISORY_NOTE,
  clip,
  collectNumbers,
  detectActionRequest,
  detectThreats,
  enforceSafeLanguage,
  findUngroundedNumbers,
  parseProviderJson,
  ProviderAnswerSchema,
  redactSensitive,
  stripExternalLinks,
  validateQuestion,
} from './ai-safety.service';
import type { ProviderAnswer } from './ai-safety.service';
import { assertWithinLimits, computeUsageStatus, estimateCostInr, getClientAiSettings, recordUsage } from './ai-usage.service';
import type { ClientAiSettings, UsageStatus } from './ai-usage.service';

// ------------------------------------------------------------------- types

export interface ResponseItem {
  ref: string;
  title: string;
  detail: string;
  severity: Severity;
  source: SourceRef;
}

export interface ResponseAction {
  text: string;
  source?: SourceRef;
  workflow?: { label: string; link: string };
}

export type AskStatus = 'success' | 'success_empty' | 'refused' | 'unknown_question';

export interface AskResponse {
  requestId: string;
  status: AskStatus;
  answer: string;
  category: Category;
  items: ResponseItem[];
  sources: SourceRef[];
  figures: Figure[];
  dateRange: { from: string; to: string; description: string };
  assumptions: string[];
  missingData: string[];
  recommendedActions: ResponseAction[];
  warnings: string[];
  suggestions?: string[];
  degraded?: boolean;
  usage: { inputTokens: number; outputTokens: number; estimatedCostInr: number; model: string; provider: string };
  usageStatus: UsageStatus;
  generatedAt: string;
}

export interface AssistantDeps {
  config: AppConfig;
  /** Read-write handle: used ONLY for AI bookkeeping tables (usage, audit, history, cache). */
  db: Db;
  /** Read-only handle: the only handle the data tools ever see. */
  roDb: Db;
  provider: AiProvider;
  now?: () => Date;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
}

// ----------------------------------------------------------- shared helpers

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function allItems(results: ToolResult[]): ToolItem[] {
  const out: ToolItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const s of r.sections) {
      for (const i of s.items) {
        if (!seen.has(i.ref)) {
          seen.add(i.ref);
          out.push(i);
        }
      }
    }
  }
  return out;
}

export interface Assembled {
  answer: string;
  items: ResponseItem[];
  sources: SourceRef[];
  figures: Figure[];
  dateRange: { from: string; to: string; description: string };
  assumptions: string[];
  missingData: string[];
  recommendedActions: ResponseAction[];
  warnings: string[];
  flags: string[];
}

/**
 * Turn the model's (untrusted) JSON into the final response. The BACKEND decides
 * what the user sees: sources, figures, date range and links come from tool
 * results, and anything the model cites that was not retrieved is dropped.
 */
export function assembleAnswer(ctx: AnswerContext, pa: ProviderAnswer, extraWarnings: string[] = []): Assembled {
  const flags: string[] = [];
  const warnings = [...extraWarnings];
  const index = new Map<string, ToolItem>();
  for (const i of allItems(ctx.toolResults)) index.set(i.ref.toUpperCase(), i);

  const scrub = (text: string): { text: string; removed: number } => {
    const noLinks = stripExternalLinks(text);
    return enforceSafeLanguage(noLinks);
  };

  let removedClaims = 0;
  const ans = scrub(pa.answer);
  removedClaims += ans.removed;
  let answer = clip(ans.text, 3500);
  if (!answer) answer = ctx.toolResults[0]?.headline ?? 'No answer could be produced from the retrieved data.';

  const items: ResponseItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const it of pa.items) {
    const base = index.get(it.ref.trim().toUpperCase());
    if (!base) {
      dropped++;
      continue;
    }
    if (seen.has(base.ref)) continue;
    seen.add(base.ref);
    const d = scrub(it.detail);
    removedClaims += d.removed;
    items.push({
      ref: base.ref,
      title: clip(stripExternalLinks(it.title) || base.title, 200),
      detail: clip(d.text || base.detail, 700),
      severity: it.severity,
      source: base.source,
    });
  }
  if (dropped) flags.push('unknown_ref_dropped');
  if (items.length === 0) {
    for (const base of allItems(ctx.toolResults).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 5)) {
      items.push({ ref: base.ref, title: base.title, detail: base.detail, severity: base.severity, source: base.source });
    }
  }

  const actions: ResponseAction[] = [];
  for (const a of pa.recommendedActions) {
    const base = a.ref ? index.get(a.ref.trim().toUpperCase()) : undefined;
    if (!base) {
      dropped++;
      continue;
    }
    const t = scrub(a.text);
    removedClaims += t.removed;
    if (!t.text) continue;
    actions.push({ text: clip(t.text, 400), source: base.source, workflow: base.source.workflow });
  }
  if (actions.length === 0) {
    for (const base of allItems(ctx.toolResults).filter((i) => i.recommendation).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 4)) {
      actions.push({ text: `${base.ref}: ${base.recommendation}`, source: base.source, workflow: base.source.workflow });
    }
  }

  if (removedClaims) {
    flags.push('unsafe_claim_removed');
    warnings.push(`Removed ${removedClaims} statement(s) that claimed an action was completed. ${ADVISORY_NOTE}`);
  }

  // Numeric grounding: every figure in the text should exist in the retrieved data.
  const allowed = collectNumbers(ctx.toolResults);
  const unverified = findUngroundedNumbers([answer, ...items.map((i) => i.detail), ...actions.map((a) => a.text)].join(' '), allowed);
  if (unverified.length) {
    flags.push('ungrounded_numbers');
    warnings.push(`Some figures in this explanation could not be matched to WhizUnik data (${unverified.slice(0, 5).join(', ')}). Please verify them in the linked records.`);
  }

  const sources: SourceRef[] = [];
  const seenSrc = new Set<string>();
  for (const s of [...items.map((i) => i.source), ...actions.map((a) => a.source).filter((s): s is SourceRef => !!s)]) {
    const k = `${s.type}:${s.ref}`;
    if (!seenSrc.has(k)) {
      seenSrc.add(k);
      sources.push(s);
    }
  }

  const missing = new Set<string>(pa.missingData.map((m) => clip(stripExternalLinks(m), 300)));
  if (ctx.blockedByRole.length) missing.add(`Not included because your role is not permitted to access it: ${ctx.blockedByRole.join(', ')}.`);
  for (const r of ctx.toolResults) {
    if (r.hiddenForRole.length) missing.add(`Withheld for your role: ${r.hiddenForRole.join(', ')}.`);
    for (const n of r.notFound) missing.add(`No record found for ${n}.`);
    for (const s of r.sections) {
      if (s.total > s.shown) {
        flags.push('truncated');
        missing.add(`Showing ${s.shown} of ${s.total} for "${s.title}"; narrow the question for the rest.`);
      }
    }
  }

  const assumptions = [...new Set([...ctx.toolResults.flatMap((r) => r.assumptions), ...pa.assumptions.map((a) => clip(stripExternalLinks(a), 300))])].slice(0, 10);

  const multi = ctx.toolResults.length > 1;
  const figures: Figure[] = ctx.toolResults.flatMap((r) => r.figures.slice(0, multi ? 3 : 10)).slice(0, 14);
  const dateRange = !multi && ctx.toolResults[0] ? ctx.toolResults[0].period : { from: ctx.today, to: ctx.today, description: `As of today (${ctx.today})` };

  return { answer, items, sources, figures, dateRange, assumptions, missingData: [...missing], recommendedActions: actions.slice(0, 8), warnings, flags };
}

export function toAppError(e: unknown, logger?: AssistantDeps['logger']): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'INVALID_API_KEY':
        return new AppError('AI_PROVIDER_AUTH', 503, 'The AI service is not configured correctly. Please contact your administrator. Normal WhizUnik workflows are not affected.');
      case 'PROVIDER_NOT_CONFIGURED':
        return new AppError('AI_PROVIDER_NOT_CONFIGURED', 503, 'The AI service has not been set up yet. Please contact your administrator. Normal WhizUnik workflows are not affected.');
      case 'PROVIDER_TIMEOUT':
        return new AppError('AI_PROVIDER_TIMEOUT', 504, 'The AI service took too long to respond. Please try again. Normal WhizUnik workflows are not affected.');
      case 'PROVIDER_RATE_LIMIT':
        return new AppError('AI_PROVIDER_RATE_LIMIT', 503, 'The AI service is busy right now. Please try again in a minute. Normal WhizUnik workflows are not affected.', { retryAfterSec: e.retryAfterSec ?? 30 });
      case 'MALFORMED_RESPONSE':
        return new AppError('AI_MALFORMED_RESPONSE', 502, 'The AI service returned an answer that could not be used. Please try again. Normal WhizUnik workflows are not affected.');
      default:
        return new AppError('AI_PROVIDER_OUTAGE', 503, 'The AI service is temporarily unavailable. Please try again later. Normal WhizUnik workflows are not affected.');
    }
  }
  logger?.error('[ai] unexpected error', redactSensitive(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  return new AppError('INTERNAL', 500, 'The AI assistant ran into a problem. Please try again. Normal WhizUnik workflows are not affected.');
}

function statusFor(err: AppError): string {
  switch (err.code) {
    case 'INVALID_QUESTION':
    case 'INVALID_REQUEST':
      return 'invalid';
    case 'AI_DISABLED':
    case 'ROLE_NOT_PERMITTED':
    case 'UNAUTHORISED_TOOL':
      return 'forbidden';
    case 'MONTHLY_LIMIT_REACHED':
    case 'DAILY_LIMIT_REACHED':
      return 'blocked_limit';
    case 'INTERNAL':
      return 'error';
    default:
      return 'provider_error';
  }
}

export const SAMPLE_QUESTIONS: Record<string, string[]> = {
  management: ['What needs attention today?', 'Which invoices above ₹1 lakh are overdue?', 'What stock may run out this month?', 'What is expected cash flow this month?'],
  sales: ['Which sales orders need attention today?', 'Why is SO-1021 waiting?', 'Which invoices above ₹1 lakh are overdue?', 'Which orders have unusual discounts?'],
  procurement: ['Which Purchase Orders are delayed?', 'Which suppliers have delayed POs?', 'What stock will run out soon?', 'Were there unusual supplier price increases?'],
  warehouse: ['What are the dispatch deadlines today?', 'What should we pick first?', 'What stock will run out soon?', 'Which stock has discrepancies?'],
  finance: ['Which invoices are overdue?', 'What is expected cash flow this month?', 'Which marketplace settlements are short?', 'Which supplier payments are due?'],
  checker: ['What approvals are pending?', 'Which approvals have been waiting more than 48 hours?', 'Which approvals are exceptions?'],
};

// ---------------------------------------------------------------- service

interface Accumulator {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class AiAssistantService {
  readonly cfg: AppConfig;
  readonly db: Db;
  readonly roDb: Db;
  readonly provider: AiProvider;
  readonly logger: NonNullable<AssistantDeps['logger']>;
  private readonly clock: () => Date;

  constructor(deps: AssistantDeps) {
    this.cfg = deps.config;
    this.db = deps.db;
    this.roDb = deps.roDb;
    this.provider = deps.provider;
    this.clock = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  now(): Date {
    return this.clock();
  }

  /** Feature flag + permitted-role checks (global flag, client flag, client role list). */
  requireEnabled(user: AuthUser): ClientAiSettings {
    const settings = getClientAiSettings(this.db, user.clientId);
    if (!this.cfg.ai.enabled || !settings || !settings.aiEnabled) {
      throw new AppError('AI_DISABLED', 403, 'The AI assistant is not enabled for your company.');
    }
    if (!settings.permittedRoles.includes(user.role)) {
      throw new AppError('ROLE_NOT_PERMITTED', 403, `The AI assistant is not enabled for the ${ROLE_DESCRIPTIONS[user.role].label} role at your company.`);
    }
    return settings;
  }

  toolContext(user: AuthUser, maxRecords: number): ToolContext {
    return { db: this.roDb, clientId: user.clientId, userId: user.id, role: user.role, now: this.now(), maxRecords };
  }

  /** Execute planned tools through the gate. Returns results in order. */
  runTools(user: AuthUser, category: Category, calls: { tool: ToolName; params: object }[], maxRecords: number): ToolResult[] {
    const gate = new ToolGate(user.role, category);
    const ctx = this.toolContext(user, maxRecords);
    return calls.map((c) => {
      gate.assertAllowed(c.tool);
      return runTool(c.tool, ctx, c.params);
    });
  }

  selectModel(complex: boolean): string {
    return complex ? this.cfg.ai.modelStrong : this.cfg.ai.modelFast;
  }

  /**
   * One provider call with a single repair retry for malformed JSON. Token use of
   * every attempt is added to `acc`, even when the call finally fails, so cost
   * is tracked for failures too.
   */
  async callModel(ctx: AnswerContext, model: string, acc: Accumulator, flags: string[]): Promise<ProviderAnswer> {
    const system = SYSTEM_PROMPT;
    const user = buildUserPrompt(ctx);
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.provider.complete({
        model,
        system,
        user: attempt === 0 ? user : `${user}\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object described above.`,
        timeoutMs: this.cfg.ai.timeoutMs,
        maxOutputTokens: this.cfg.ai.maxOutputTokens,
        context: ctx,
      });
      acc.inputTokens += resp.inputTokens;
      acc.outputTokens += resp.outputTokens;
      acc.model = resp.model;
      try {
        return ProviderAnswerSchema.parse(parseProviderJson(resp.text));
      } catch {
        flags.push('malformed_retry');
      }
    }
    throw new ProviderError('MALFORMED_RESPONSE', 'The AI provider returned malformed JSON twice.');
  }

  private knownNames(clientId: number) {
    const names = (table: 'suppliers' | 'customers') =>
      (this.roDb.prepare(`SELECT name FROM ${table} WHERE client_id = ?`).all(clientId) as { name: string }[]).map((r) => r.name);
    return { suppliers: names('suppliers'), customers: names('customers') };
  }

  private baseResponse(args: {
    requestId: string;
    status: AskStatus;
    answer: string;
    category: Category;
    usageStatus: UsageStatus;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    extra?: Partial<AskResponse>;
  }): AskResponse {
    return {
      requestId: args.requestId,
      status: args.status,
      answer: args.answer,
      category: args.category,
      items: [],
      sources: [],
      figures: [],
      dateRange: { from: istDate(this.now()), to: istDate(this.now()), description: `As of today (${istDate(this.now())})` },
      assumptions: [],
      missingData: [],
      recommendedActions: [],
      warnings: [],
      usage: { inputTokens: args.inputTokens ?? 0, outputTokens: args.outputTokens ?? 0, estimatedCostInr: args.cost ?? 0, model: args.model ?? 'none', provider: this.provider.name },
      usageStatus: args.usageStatus,
      generatedAt: this.now().toISOString(),
      ...args.extra,
    };
  }

  // --------------------------------------------------------------- ask

  async ask(user: AuthUser, rawQuestion: unknown): Promise<AskResponse> {
    const started = performance.now();
    const requestId = randomUUID();
    const rec = {
      status: 'error',
      category: null as Category | null,
      tools: [] as string[],
      model: null as string | null,
      flags: [] as string[],
      question: '',
      response: null as AskResponse | null,
      error: null as AppError | null,
      acc: { inputTokens: 0, outputTokens: 0, model: 'none' } as Accumulator,
    };

    try {
      const check = validateQuestion(rawQuestion, this.cfg.ai.maxQuestionChars);
      if (!check.ok) throw new AppError('INVALID_QUESTION', 400, check.message);
      const question = check.question;
      rec.question = question;

      const settings = this.requireEnabled(user);
      const usageBefore = computeUsageStatus(this.db, settings, user.id, this.now());
      assertWithinLimits(usageBefore);

      // ---- refuse malicious questions and action requests without calling the provider
      const threats = detectThreats(question);
      if (threats.length) {
        rec.flags.push(...threats.map((t) => `threat:${t}`), 'injection_suspected');
        rec.status = 'refused';
        rec.category = 'unknown';
        rec.response = this.baseResponse({
          requestId,
          status: 'refused',
          category: 'unknown',
          usageStatus: usageBefore,
          answer:
            'I can’t help with that request. WhizUnik AI only answers business questions from your own company’s approved WhizUnik data. It never reveals system instructions, credentials, or other companies’ data.',
          extra: { suggestions: SAMPLE_QUESTIONS[user.role] },
        });
        return rec.response;
      }
      const action = detectActionRequest(question);
      if (action) {
        rec.flags.push('action_request_refused');
        rec.status = 'refused';
        rec.category = 'unknown';
        rec.response = this.baseResponse({
          requestId,
          status: 'refused',
          category: 'unknown',
          usageStatus: usageBefore,
          answer: `I can’t ${action.verb} anything: ${ADVISORY_NOTE}`,
          extra: {
            recommendedActions: [{ text: `Open ${action.workflowHint.label} and follow the normal approval process.`, workflow: action.workflowHint }],
            suggestions: SAMPLE_QUESTIONS[user.role],
          },
        });
        return rec.response;
      }

      // ---- classify
      const today = istDate(this.now());
      const cls = classifyQuestion(question, today, this.knownNames(user.clientId));
      rec.category = cls.category;
      if (cls.category === 'unknown') {
        rec.status = 'unknown_question';
        rec.response = this.baseResponse({
          requestId,
          status: 'unknown_question',
          category: 'unknown',
          usageStatus: usageBefore,
          answer:
            'I’m not sure what you’re asking. I can answer questions about sales orders, invoices and overdue payments, stock, purchase orders and suppliers, warehouse tasks, marketplace orders and cash flow, using your WhizUnik data.',
          extra: { suggestions: SAMPLE_QUESTIONS[user.role] },
        });
        return rec.response;
      }

      // ---- tools: approved for the category AND permitted for the role
      const selection = selectTools(cls, user.role, today);
      if (selection.calls.length === 0) {
        const blocked = selection.blockedByRole;
        const roles = [...new Set(blocked.flatMap((t) => TOOL_PERMISSIONS[t]))].map((r) => ROLE_DESCRIPTIONS[r].label);
        rec.flags.push('tool_blocked_by_role');
        throw new AppError(
          'ROLE_NOT_PERMITTED',
          403,
          `Your role (${ROLE_DESCRIPTIONS[user.role].label}) is not permitted to access this data through the AI assistant.${roles.length ? ` It is available to: ${roles.join(', ')}.` : ''}`,
          { category: cls.category, allowedRoles: roles },
        );
      }
      if (selection.blockedByRole.length) rec.flags.push('tool_blocked_by_role');

      const maxRecords = cls.category === 'management' ? 6 : this.cfg.ai.maxRecordsPerTool;
      const toolResults = this.runTools(user, cls.category, selection.calls, maxRecords);
      rec.tools = selection.calls.map((c) => c.tool);

      const ctx: AnswerContext = {
        mode: 'ask',
        question,
        category: cls.category,
        role: user.role,
        today,
        period: toolResults.length === 1 ? toolResults[0].period : { from: today, to: today, description: `As of today (${today})` },
        toolResults,
        // Plain-language names, de-duplicated: users never see internal function names.
        blockedByRole: [...new Set(selection.blockedByRole.map((t) => TOOL_LABELS[t]))],
      };

      // ---- no matching records: answer deterministically, no provider call (saves cost, avoids invention)
      if (toolResults.every((r) => r.empty)) {
        const pa = composeLocalAnswer(ctx);
        const asm = assembleAnswer(ctx, pa);
        rec.status = 'success_empty';
        rec.flags.push(...asm.flags);
        rec.response = this.baseResponse({
          requestId,
          status: 'success_empty',
          category: cls.category,
          usageStatus: usageBefore,
          answer: asm.answer,
          extra: { ...this.pick(asm), items: [], sources: [], missingData: [...asm.missingData, 'No matching records were found in WhizUnik for this question.'] },
        });
        return rec.response;
      }

      // ---- model call
      const model = this.selectModel(isComplexQuestion(cls, selection.calls.length));
      rec.model = model;
      let pa: ProviderAnswer;
      try {
        pa = await this.callModel(ctx, model, rec.acc, rec.flags);
      } catch (e) {
        const err = toAppError(e, this.logger);
        if (e instanceof ProviderError) {
          // Operators need to tell an invalid key from a timeout or a quota problem (code only: never the provider's text).
          rec.flags.push(`provider:${e.code}`);
          this.logger.warn(`[ai] provider error ${e.code} (client ${user.clientId}, model ${model})`);
        }
        // Degraded mode: the user still gets the records that were retrieved.
        const fallback = assembleAnswer(ctx, composeLocalAnswer(ctx));
        throw new AppError(err.code, err.status, err.message, {
          ...err.extra,
          fallback: this.baseResponse({
            requestId,
            status: 'success',
            category: cls.category,
            usageStatus: usageBefore,
            answer: `${fallback.answer}`,
            extra: { ...this.pick(fallback), degraded: true, warnings: [...fallback.warnings, 'The AI service is unavailable, so this is a plain summary of the matching WhizUnik records without AI analysis.'] },
          }),
        });
      }

      const asm = assembleAnswer(ctx, pa);
      rec.flags.push(...asm.flags);
      const cost = estimateCostInr(this.cfg, rec.acc.model, rec.acc.inputTokens, rec.acc.outputTokens);
      rec.status = 'success';
      rec.response = this.baseResponse({
        requestId,
        status: 'success',
        category: cls.category,
        usageStatus: usageBefore,
        answer: asm.answer,
        model: rec.acc.model,
        inputTokens: rec.acc.inputTokens,
        outputTokens: rec.acc.outputTokens,
        cost,
        extra: this.pick(asm),
      });
      return rec.response;
    } catch (e) {
      const err = toAppError(e, this.logger);
      rec.error = err;
      rec.status = statusFor(err);
      throw err;
    } finally {
      this.finalize(user, requestId, rec, started);
    }
  }

  private pick(a: Assembled): Partial<AskResponse> {
    return {
      items: a.items,
      sources: a.sources,
      figures: a.figures,
      dateRange: a.dateRange,
      assumptions: a.assumptions,
      missingData: a.missingData,
      recommendedActions: a.recommendedActions,
      warnings: a.warnings,
    };
  }

  /** Usage + audit + history. Failures here are logged loudly but never break the user's request. */
  private finalize(
    user: AuthUser,
    requestId: string,
    rec: { status: string; category: Category | null; tools: string[]; model: string | null; flags: string[]; question: string; response: AskResponse | null; error: AppError | null; acc: Accumulator },
    started: number,
  ): void {
    const now = this.now();
    const processingMs = performance.now() - started;
    const model = rec.acc.model !== 'none' ? rec.acc.model : rec.model ?? 'none';
    const cost = estimateCostInr(this.cfg, model, rec.acc.inputTokens, rec.acc.outputTokens);
    try {
      if (rec.status !== 'invalid' && rec.question) {
        recordUsage(this.db, {
          clientId: user.clientId,
          userId: user.id,
          requestId,
          kind: 'ask',
          question: redactSensitive(rec.question),
          now,
          model,
          provider: this.provider.name,
          inputTokens: rec.acc.inputTokens,
          outputTokens: rec.acc.outputTokens,
          estCostInr: cost,
          status: rec.status,
        });
      }
    } catch (e) {
      this.logger.error('[ai] failed to record usage', redactSensitive(String(e)));
    }
    try {
      recordAudit(this.db, {
        requestId,
        now,
        clientId: user.clientId,
        userId: user.id,
        role: user.role,
        category: rec.category,
        toolsUsed: rec.tools,
        model: model === 'none' ? null : model,
        provider: this.provider.name,
        status: rec.status,
        processingMs,
        inputTokens: rec.acc.inputTokens,
        outputTokens: rec.acc.outputTokens,
        estCostInr: cost,
        flags: [...new Set(rec.flags)],
      });
    } catch (e) {
      this.logger.error('[ai] failed to write audit log', redactSensitive(String(e)));
    }
    try {
      if (rec.question && rec.status !== 'invalid') {
        const payload = rec.response ?? { error: { code: rec.error?.code ?? 'INTERNAL', message: rec.error?.message ?? 'Request failed' } };
        saveHistory(this.db, { clientId: user.clientId, userId: user.id, requestId, now, question: redactSensitive(rec.question), category: rec.category, status: rec.status, response: payload });
      }
    } catch (e) {
      this.logger.error('[ai] failed to save history', redactSensitive(String(e)));
    }
    // Refresh the usage numbers shown on the response so warnings reflect this request.
    if (rec.response) {
      try {
        const settings = getClientAiSettings(this.db, user.clientId);
        if (settings) rec.response.usageStatus = computeUsageStatus(this.db, settings, user.id, now);
      } catch {
        /* ignore */
      }
    }
  }

  /** Exposed for the summary service. */
  classification(question: string, clientId: number): Classification {
    return classifyQuestion(question, istDate(this.now()), this.knownNames(clientId));
  }

  toolsPermittedFor(user: AuthUser): ToolName[] {
    return toolsForRole(user.role);
  }
}
