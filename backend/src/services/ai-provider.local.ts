import type { AiProvider, AnswerContext, ConnectionTestResult, ProviderRequest, ProviderResponse } from './ai-provider.types';
import type { ProviderAnswer } from './ai-safety.service';
import type { Severity } from '../types';
import type { ToolItem, ToolResult } from './ai-data-tools.service';
import { formatInr } from '../utils/money';

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function topItems(results: ToolResult[], perTool: number, total: number): { item: ToolItem; tool: string }[] {
  const picked: { item: ToolItem; tool: string }[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const flat = r.sections
      .flatMap((s) => s.items)
      .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    let n = 0;
    for (const item of flat) {
      if (seen.has(item.ref) || n >= perTool) continue;
      seen.add(item.ref);
      picked.push({ item, tool: r.tool });
      n++;
    }
  }
  return picked.sort((a, b) => RANK[b.item.severity] - RANK[a.item.severity]).slice(0, total);
}

function shortOrderLine(item: ToolItem): string {
  const d = item.data as { status?: string; promisedDate?: string; daysLate?: number; total?: number; customer?: string };
  const late = d.daysLate && d.daysLate > 0 ? ` (${d.daysLate} day${d.daysLate === 1 ? '' : 's'} late)` : '';
  return `Status: ${String(d.status ?? '').replace(/_/g, ' ')}; promised ${d.promisedDate ?? 'n/a'}${late}${d.total !== undefined ? `; order value ${formatInr(d.total)}` : ''}.`;
}

/**
 * Deterministic answer composer. It restates the retrieved data — it adds no
 * facts of its own. Used (a) as the development provider when no OpenAI key is
 * configured, and (b) as the degraded fallback when the hosted provider fails.
 */
export function composeLocalAnswer(ctx: AnswerContext): ProviderAnswer {
  const results = ctx.toolResults;
  const multi = results.length > 1;
  const detailTool = results.find((r) => r.tool === 'getSalesOrderDetail' && r.sections[0]?.items[0]);

  let answer: string;
  if (detailTool) {
    const main = detailTool.sections[0].items[0];
    answer = `${detailTool.headline} ${main.detail}`;
  } else if (multi) {
    answer = [
      ctx.mode === 'summary' ? `Management summary for ${ctx.today}:` : `Here is what needs attention as of ${ctx.today}:`,
      ...results.map((r) => `• ${r.headline}`),
    ].join('\n');
  } else {
    const r = results[0];
    const lead = r
      ? topItems([r], 3, 3)
          .map((p) => p.item.title)
          .join('; ')
      : '';
    answer = r ? `${r.headline}${lead ? ` Most important: ${lead}.` : ''}` : 'No data was retrieved.';
  }

  const items = topItems(results, multi ? 3 : 10, multi ? 12 : 10).map(({ item }) => ({
    ref: item.ref,
    title: item.title,
    // The full explanation is already in the answer text; the main order only needs a short status line here.
    detail: detailTool && item.ref === detailTool.sections[0]?.items[0]?.ref ? shortOrderLine(item) : item.detail,
    severity: item.severity,
  }));

  const actions: { text: string; ref: string }[] = [];
  const seenText = new Set<string>();
  for (const { item } of topItems(results, multi ? 3 : 6, 8)) {
    if (!item.recommendation) continue;
    const text = `${item.ref}: ${item.recommendation}`;
    if (seenText.has(text)) continue;
    seenText.add(text);
    actions.push({ text, ref: item.ref });
    if (actions.length >= 6) break;
  }

  const assumptions = [...new Set(results.flatMap((r) => r.assumptions))].slice(0, 8);
  const missing: string[] = [];
  if (ctx.blockedByRole.length) missing.push(`Not included because your role is not permitted to access it: ${ctx.blockedByRole.join(', ')}.`);
  for (const r of results) {
    if (r.hiddenForRole.length) missing.push(`Withheld for your role: ${r.hiddenForRole.join(', ')}.`);
    for (const n of r.notFound) missing.push(`No record found for ${n}.`);
  }

  return { answer, items, assumptions, missingData: [...new Set(missing)], recommendedActions: actions };
}

export class LocalProvider implements AiProvider {
  readonly name = 'local' as const;

  constructor(private readonly models: { fast: string; strong: string }) {}

  isConfigured(): boolean {
    return true;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const text = JSON.stringify(composeLocalAnswer(req.context));
    return {
      text,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      model: 'local-rules-v1',
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      provider: 'local',
      ok: true,
      configured: true,
      models: this.models,
      message: 'Using the built-in rules engine (no external AI provider, no cost). Set AI_PROVIDER=openai and OPENAI_API_KEY to use the hosted model.',
      latencyMs: 0,
    };
  }
}
