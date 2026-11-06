import type { Category, Role, ToolName } from '../types';
import { addDays, diffDays, endOfMonth, startOfNextMonth, startOfWeek } from '../utils/dates';
import { parseAmount } from '../utils/money';
import { CATEGORY_TOOLS, canUseTool } from './ai-permissions.service';
import type { ToolParams } from './ai-data-tools.service';

/**
 * Question classification + tool-selection rules (spec Task 5).
 *
 * Classification is deterministic (keyword scoring), so it costs nothing,
 * cannot be talked out of its rules, and is easy to test. The model never picks
 * tools; the backend does, from the list approved for the category and the role.
 */

type Scored = Exclude<Category, 'unknown'>;

const KEYWORDS: Record<Scored, [RegExp, number][]> = {
  sales: [
    [/\bsales?\s+orders?\b/, 4],
    [/\bso-\d+/, 5],
    [/\border\s+(?:is|are)\s+(?:blocked|waiting|stuck|delayed)\b/, 3],
    [/\borders?\b.{0,30}\b(?:waiting|pending|awaiting)\b.{0,15}\bdispatch/, 5],
    [/\bcustomers?\b/, 2],
    [/\bdiscounts?\b/, 3],
    [/\bquot(?:e|es|ation)\b/, 2],
    [/\bopportunit/, 3],
    [/\bfollow[\s-]?ups?\b/, 2],
    [/\borders?\b/, 1],
  ],
  procurement: [
    [/\bpurchase\s+orders?\b/, 4],
    [/\bpo-\d+/, 5],
    [/\bpos\b/, 4],
    [/\bsuppliers?\b/, 3],
    [/\bvendors?\b/, 3],
    [/\bpurchas(?:e|ing)\b/, 2],
    [/\bprocure/, 3],
    [/\b(?:price (?:increase|comparison)|unusual price|price rise)\b/, 3],
    [/\bsupplier delivery\b/, 3],
  ],
  inventory: [
    [/\bstock\b/, 3],
    [/\bskus?\b/, 3],
    [/\bsku-\d+/, 5],
    [/\binventory\b/, 4],
    [/\breorder/, 4],
    [/\brun\s+out\b|\bstock[\s-]?out\b|\bout of stock\b/, 4],
    [/\b(?:slow|fast)[\s-]?moving\b|\bdead stock\b/, 4],
    [/\bduplicate/, 3],
    [/\bstock movements?\b|\bunusual (?:stock )?movement/, 4],
  ],
  warehouse: [
    [/\bwarehouse\b/, 5],
    [/\bpick(?:ing|s)?\b/, 3],
    [/\bpack(?:ing)?\b/, 3],
    [/\bdispatch(?:es|ed)?\b/, 4],
    [/\bwt-\d+/, 5],
    [/\bquarantin/, 4],
    [/\bdamaged\b/, 4],
    [/\bdiscrepanc/, 3],
    [/\bworkload\b/, 3],
    [/\bcycle count\b|\bputaway\b/, 3],
  ],
  finance: [
    [/\binvoices?\b/, 4],
    [/\binv-\d+/, 5],
    [/\bbill-\d+/, 5],
    [/\boverdue\b/, 3],
    [/\breceivables?\b|\bpayables?\b/, 4],
    [/\bcash[\s-]?flow\b/, 5],
    [/\bcollections?\b/, 3],
    [/\bpayments?\b/, 2],
    [/\bsupplier payments?\b/, 4],
    [/\boutstanding\b/, 3],
    [/\bcredit notes?\b/, 2],
    [/\bsettlements?\b/, 3],
    [/\btreasury\b|\bliquidity\b|\binflows?\b|\boutflows?\b/, 3],
  ],
  marketplace: [
    [/\bmarketplaces?\b/, 6],
    [/\b(?:amazon|flipkart|myntra)\b/, 5],
    [/\bmp-[a-z]+-\d+/, 5],
    [/\bunmapped\b|\bmapping\b|\bmapped\b/, 4],
    [/\bapi\s+(?:failures?|errors?)\b/, 4],
    [/\breturn[\s-]risk\b|\breturns?\b/, 3],
    [/\blistings?\b/, 3],
  ],
  management: [
    [/\b(?:what|which things?|anything)\b[^.?]{0,25}\bneeds?\s+(?:my\s+)?attention\b/, 7],
    [/\b(?:daily|business|management|morning)\s+(?:business\s+)?(?:summary|brief|overview|digest)\b/, 7],
    [/\boverview\b/, 4],
    [/\bacross\s+(?:all\s+)?departments?\b|\bcross[\s-]department\b/, 5],
    [/\b(?:key|top|biggest|main)\s+risks?\b/, 5],
    [/\bhow\s+is\s+the\s+business\b|\bbusiness\s+health\b/, 5],
    [/\brecommended\s+(?:next\s+)?actions?\b/, 4],
    [/\bapprovals?\b|\bexceptions?\b/, 3],
    [/\bsummary\b|\bsummarise\b|\bsummarize\b/, 2],
  ],
};

const TIE_ORDER: Scored[] = ['marketplace', 'warehouse', 'procurement', 'finance', 'inventory', 'sales', 'management'];

export interface Classification {
  category: Category;
  confidence: number;
  scores: Partial<Record<Scored, number>>;
  refs: { prefix: string; ref: string }[];
  period: { from: string; to: string; description: string; explicit: boolean } | null;
  soon: boolean;
  params: ToolParams;
  text: string; // normalised question (lower case)
}

export interface KnownNames {
  suppliers?: string[];
  customers?: string[];
}

function findName(q: string, names: string[] = []): string | undefined {
  const lower = q.toLowerCase();
  for (const n of names) {
    const full = n.toLowerCase();
    if (lower.includes(full)) return n;
    const first = full.split(/\s+/)[0];
    if (first.length >= 4 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(lower)) return n;
  }
  return undefined;
}

export function extractPeriod(q: string, today: string): Classification['period'] {
  const t = q.toLowerCase();
  let m: RegExpExecArray | null;
  if (/\btoday\b/.test(t)) return { from: today, to: today, description: `today (${today})`, explicit: true };
  if (/\btomorrow\b/.test(t)) {
    const d = addDays(today, 1);
    return { from: d, to: d, description: `tomorrow (${d})`, explicit: true };
  }
  if ((m = /\b(?:next|coming|upcoming|within|in the next)\s+(\d{1,3})\s+days?\b/.exec(t))) {
    const n = Math.min(Number(m[1]), 365);
    return { from: today, to: addDays(today, n), description: `next ${n} days`, explicit: true };
  }
  if (/\bnext\s+week\b/.test(t)) {
    const s = addDays(startOfWeek(today), 7);
    return { from: s, to: addDays(s, 6), description: 'next week', explicit: true };
  }
  if (/\bthis\s+week\b/.test(t)) {
    const s = startOfWeek(today);
    return { from: today, to: addDays(s, 6), description: 'this week', explicit: true };
  }
  if (/\bnext\s+month\b/.test(t)) {
    const s = startOfNextMonth(today);
    return { from: s, to: endOfMonth(s), description: 'next month', explicit: true };
  }
  if (/\bthis\s+month\b|\bmonth[\s-]to[\s-]date\b/.test(t)) {
    return { from: today, to: endOfMonth(today), description: `rest of this month (${today} to ${endOfMonth(today)})`, explicit: true };
  }
  return null;
}

export function classifyQuestion(question: string, today: string, known: KnownNames = {}): Classification {
  const text = question.toLowerCase();
  const scores: Partial<Record<Scored, number>> = {};
  for (const cat of Object.keys(KEYWORDS) as Scored[]) {
    let s = 0;
    for (const [re, w] of KEYWORDS[cat]) if (re.test(text)) s += w;
    if (s > 0) scores[cat] = s;
  }

  const refs = [...question.matchAll(/\b(SO|PO|INV|SKU|WT|MP|ST|APR|BILL|EVT)-[A-Z0-9][A-Z0-9-]*/gi)].map((m) => ({
    prefix: m[1].toUpperCase(),
    ref: m[0].toUpperCase(),
  }));

  let category: Category = 'unknown';
  let top = 0;
  for (const cat of TIE_ORDER) {
    const s = scores[cat] ?? 0;
    if (s > top) {
      top = s;
      category = cat;
    }
  }
  const sum = Object.values(scores).reduce((a, b) => a + (b ?? 0), 0);
  const confidence = sum ? Number((top / sum).toFixed(2)) : 0;

  const period = extractPeriod(question, today);
  const soon = /\bsoon\b|\bshortly\b|\bimminent/.test(text);

  const params: ToolParams = {};
  const cue = /(?:above|over|more than|greater than|exceeding|at least|minimum of|>=?)\s*((?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?|cr|thousand|million|k|l|m)?)/i.exec(question);
  if (cue) {
    const v = parseAmount(cue[1]);
    if (v !== null) params.minAmount = v;
  }
  const below = /(?:below|under|less than|up to|at most|<=?)\s*((?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?|cr|thousand|million|k|l|m)?)/i.exec(question);
  if (below) {
    const v = parseAmount(below[1]);
    if (v !== null) params.maxAmount = v;
  }
  const mp = /\b(amazon|flipkart|myntra)\b/i.exec(question);
  if (mp) params.marketplace = mp[1][0].toUpperCase() + mp[1].slice(1).toLowerCase();
  const supplier = findName(question, known.suppliers);
  if (supplier) params.supplier = supplier;
  const customer = findName(question, known.customers);
  if (customer) params.customer = customer;

  return { category, confidence, scores, refs, period, soon, params, text };
}

export interface PlannedCall {
  tool: ToolName;
  params: ToolParams;
}

export interface ToolSelection {
  calls: PlannedCall[];
  /** Tools the question needed but the user's role may not use. */
  blockedByRole: ToolName[];
}

function stockFocus(text: string): ToolParams['focus'] {
  if (/\bduplicate/.test(text)) return 'duplicates';
  if (/\b(?:slow|fast)[\s-]?moving\b|\bdead stock\b|\bnot selling\b/.test(text)) return 'slow';
  if (/\bmovement|\bunusual|\badjust/.test(text)) return 'movements';
  if (/\brun\s+out\b|\bstock[\s-]?out|\bshortage|\blow stock|\breorder|\bout of stock|\bwill run\b/.test(text)) return 'stockout';
  return 'all';
}

/**
 * Tool-selection rules. Returns only tools that are (a) approved for the
 * category and (b) permitted for the role; everything else is reported in
 * `blockedByRole` so the answer can disclose it.
 */
export function selectTools(c: Classification, role: Role, today: string): ToolSelection {
  const t = c.text;
  const wanted: PlannedCall[] = [];
  const base = c.params;

  const horizon = (): number | undefined => {
    if (c.period) return Math.max(1, diffDays(c.period.to, today));
    if (c.soon) return 14;
    return undefined;
  };
  const range = c.period ? { from: c.period.from, to: c.period.to } : {};

  switch (c.category) {
    case 'sales': {
      const so = c.refs.find((r) => r.prefix === 'SO');
      if (so) wanted.push({ tool: 'getSalesOrderDetail', params: { ref: so.ref } });
      else wanted.push({ tool: 'getOpenSalesOrders', params: base });
      if (/\bcollect|\bfollow[\s-]?up|\boverdue\b|\bpayment|\boutstanding\b/.test(t)) wanted.push({ tool: 'getOverdueInvoices', params: base });
      break;
    }
    case 'procurement': {
      wanted.push({ tool: 'getDelayedPurchaseOrders', params: base });
      if (/\bshortage|\breorder|\brecommend|\bshould we (?:buy|order)|\bwhat (?:should|do) we (?:buy|order)\b|\bpurchase recommend/.test(t)) {
        wanted.push({ tool: 'getLowStockProducts', params: { focus: 'stockout', horizonDays: horizon() } });
      }
      break;
    }
    case 'inventory':
      wanted.push({ tool: 'getLowStockProducts', params: { focus: stockFocus(t), horizonDays: horizon() } });
      break;
    case 'warehouse':
      wanted.push({ tool: 'getPendingWarehouseTasks', params: base });
      break;
    case 'finance': {
      const wantsInvoices = /\binvoice|\binv-|\boverdue|\breceivable|\bcollection|\boutstanding|\bcustomer balance/.test(t);
      const wantsCash = /\bcash|\bpayable|\bsupplier payment|\bpayments?\b|\bsettlement|\binflow|\boutflow|\bliquidity|\btreasury|\bbill-/.test(t);
      if (wantsInvoices || !wantsCash) wanted.push({ tool: 'getOverdueInvoices', params: base });
      if (wantsCash || !wantsInvoices) wanted.push({ tool: 'getCashFlowSummary', params: { ...base, ...range } });
      // "Expected versus received marketplace settlements" is Finance intelligence in the PDF (section 5).
      if (/\bsettlement/.test(t)) wanted.push({ tool: 'getMarketplaceExceptions', params: base });
      break;
    }
    case 'marketplace':
      wanted.push({ tool: 'getMarketplaceExceptions', params: base });
      break;
    case 'management':
      // A broad "what needs attention" question always looks 14 days ahead for stock; "today" only describes the attention list.
      for (const tool of CATEGORY_TOOLS.management) wanted.push({ tool, params: tool === 'getLowStockProducts' ? { focus: 'stockout', horizonDays: 14 } : {} });
      break;
    case 'unknown':
      break;
  }

  const calls: PlannedCall[] = [];
  const blockedByRole: ToolName[] = [];
  for (const w of wanted) {
    if (!CATEGORY_TOOLS[c.category].includes(w.tool)) continue; // never outside the category
    if (canUseTool(role, w.tool)) calls.push(w);
    else blockedByRole.push(w.tool);
  }
  return { calls, blockedByRole };
}

/** Questions that need deeper analysis use the stronger (more expensive) model. */
export function isComplexQuestion(c: Classification, callCount: number): boolean {
  // PDF section 3: the stronger model is for "complex management analysis". Single-topic questions, even
  // "why" questions about one record, use the lower-cost model.
  return c.category === 'management' || callCount >= 3;
}
