import type { Db, Role, Severity, SourceRef, ToolName } from '../types';
import { AppError } from '../errors';
import { addDays, diffDays, endOfMonth, istDate } from '../utils/dates';
import { formatInr } from '../utils/money';
import { canAccessRecord, canSeeField, canUseTool } from './ai-permissions.service';
import { sourceRef } from './record-links';
import { sanitizeDataText as clean } from './ai-safety.service';

/**
 * Approved data tools (spec section 7 / Task 4).
 *
 * Every tool:
 *  - takes the authenticated client id and filters EVERY query on it,
 *  - runs on a READ-ONLY database handle (so it cannot change any record),
 *  - selects only the fields it needs (never password hashes, tokens, e-mail
 *    addresses, phone numbers or bank details),
 *  - strips fields the user's role may not see (`hiddenForRole`),
 *  - caps the number of records returned and says when it truncated.
 */

export interface ToolContext {
  db: Db;
  clientId: number;
  userId: number;
  role: Role;
  now: Date;
  maxRecords: number;
}

export interface ToolParams {
  ref?: string;
  minAmount?: number;
  maxAmount?: number;
  customer?: string;
  supplier?: string;
  marketplace?: string;
  horizonDays?: number;
  focus?: 'all' | 'stockout' | 'slow' | 'duplicates' | 'movements';
  from?: string;
  to?: string;
}

export interface Figure {
  label: string;
  value: string | number;
}

export interface ToolItem {
  ref: string;
  source: SourceRef;
  title: string;
  detail: string;
  severity: Severity;
  flags: string[];
  recommendation?: string;
  data: Record<string, unknown>;
}

export interface ToolSection {
  key: string;
  title: string;
  total: number;
  shown: number;
  items: ToolItem[];
}

export interface ToolResult {
  tool: ToolName;
  headline: string;
  period: { from: string; to: string; description: string };
  figures: Figure[];
  sections: ToolSection[];
  assumptions: string[];
  hiddenForRole: string[];
  notFound: string[];
  empty: boolean;
}

// ------------------------------------------------------------------ helpers

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function maxSev(...s: Severity[]): Severity {
  return s.reduce((a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a), 'low' as Severity);
}

function section(key: string, title: string, items: ToolItem[], max: number): ToolSection {
  const sorted = [...items].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  return { key, title, total: items.length, shown: Math.min(items.length, max), items: sorted.slice(0, max) };
}

function requireTool(ctx: ToolContext, tool: ToolName): void {
  if (!canUseTool(ctx.role, tool)) {
    throw new AppError('UNAUTHORISED_TOOL', 403, `Your role is not permitted to use ${tool}.`, { tool });
  }
}

function finish(
  tool: ToolName,
  base: Omit<ToolResult, 'tool' | 'empty' | 'hiddenForRole' | 'notFound'> & { hiddenForRole?: string[]; notFound?: string[] },
): ToolResult {
  const notFound = base.notFound ?? [];
  return {
    tool,
    ...base,
    hiddenForRole: base.hiddenForRole ?? [],
    notFound,
    empty: base.sections.every((s) => s.total === 0),
  };
}

function includesCI(haystack: string, needle?: string): boolean {
  return !needle || haystack.toLowerCase().includes(needle.toLowerCase());
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function daysText(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

// ------------------------------------------------------------ sales orders

interface SoRow {
  so_number: string;
  status: string;
  order_date: string;
  promised_date: string;
  total: number;
  discount_pct: number;
  blocked_reason: string | null;
  waiting_note: string | null;
  customer: string;
}

const SO_STATUS_TEXT: Record<string, string> = {
  open: 'open',
  waiting_stock: 'waiting for stock',
  waiting_customer_approval: 'waiting for customer approval',
  waiting_checker_approval: 'waiting for Checker approval',
  waiting_dispatch: 'waiting for warehouse dispatch',
  blocked: 'blocked',
};

const HIGH_VALUE_ORDER = 500_000;
const UNUSUAL_DISCOUNT_PCT = 20;

export function getOpenSalesOrders(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getOpenSalesOrders');
  const today = istDate(ctx.now);

  const rows = (
    ctx.db
      .prepare(
        `SELECT s.so_number, s.status, s.order_date, s.promised_date, s.total, s.discount_pct,
                s.blocked_reason, s.waiting_note, c.name AS customer
           FROM sales_orders s
           JOIN customers c ON c.id = s.customer_id AND c.client_id = s.client_id
          WHERE s.client_id = ? AND s.status NOT IN ('dispatched','invoiced','closed','cancelled')
          ORDER BY s.promised_date, s.so_number`,
      )
      .all(ctx.clientId) as SoRow[]
  ).filter(
    (r) =>
      (params.minAmount === undefined || r.total > params.minAmount) &&
      (params.maxAmount === undefined || r.total < params.maxAmount) &&
      includesCI(r.customer, params.customer),
  );

  const counts = { delayed: 0, dueToday: 0, stock: 0, customerApproval: 0, checker: 0, dispatch: 0, blocked: 0, discount: 0, highValue: 0 };
  const items: ToolItem[] = [];

  for (const r of rows) {
    const flags: string[] = [];
    const sev: Severity[] = ['low'];
    const daysLate = Math.max(0, diffDays(today, r.promised_date));
    const reasons: string[] = [];
    let recommendation: string | undefined;

    if (r.status === 'blocked') {
      flags.push('blocked'); counts.blocked++; sev.push('high');
      recommendation = 'Review why the order is blocked (use "Why is <order> blocked?"), then clear it through the existing approval process.';
    }
    if (r.promised_date < today) {
      flags.push('delayed'); counts.delayed++; sev.push('high');
      reasons.push(`promised for ${r.promised_date} (${daysText(daysLate)} late)`);
    } else if (r.promised_date === today) {
      flags.push('due_today'); counts.dueToday++; sev.push('medium');
      reasons.push('promised for today');
    }
    if (r.status === 'waiting_stock') {
      flags.push('waiting_stock'); counts.stock++;
      sev.push(r.promised_date <= addDays(today, 3) ? 'high' : 'medium');
      recommendation = 'Open the Sales Orders queue, check the short SKUs and the status of the supplier delivery (Procurement queue).';
    }
    if (r.status === 'waiting_customer_approval') {
      flags.push('waiting_customer_approval'); counts.customerApproval++; sev.push('medium');
      recommendation = 'Follow up with the customer for sign-off, then continue the order in the Sales Orders queue.';
    }
    if (r.status === 'waiting_checker_approval') {
      flags.push('waiting_checker_approval'); counts.checker++; sev.push('medium');
      recommendation = 'Ask the Checker to review the pending approval in the Checker approvals queue.';
    }
    if (r.status === 'waiting_dispatch') {
      flags.push('waiting_dispatch'); counts.dispatch++; sev.push(r.promised_date <= today ? 'high' : 'medium');
      recommendation = 'Ask the warehouse to complete dispatch from the Warehouse queue.';
    }
    if (r.discount_pct >= UNUSUAL_DISCOUNT_PCT) {
      flags.push('unusual_discount'); counts.discount++; sev.push('medium');
      reasons.push(`discount of ${r.discount_pct}% is unusually high`);
      recommendation ??= 'Confirm the discount is justified; it needs Checker approval under the existing policy.';
    }
    if (r.total >= HIGH_VALUE_ORDER) {
      flags.push('high_value'); counts.highValue++;
      reasons.push(`high-value order of ${formatInr(r.total)}`);
      recommendation ??= 'Prioritise stock allocation and customer communication for this high-value order.';
    }
    if (flags.length === 0) continue; // healthy open order

    const statusText = SO_STATUS_TEXT[r.status] ?? r.status;
    const note = clean(r.blocked_reason ?? r.waiting_note, 220);
    const lead = `${r.so_number} for ${clean(r.customer, 80)} (${formatInr(r.total)}) is ${statusText}; ${reasons.length ? reasons.join('; ') : `promised for ${r.promised_date}`}`;
    const detail = note ? `${lead}. ${note}` : lead;

    items.push({
      ref: r.so_number,
      source: sourceRef('sales-orders', r.so_number, clean(r.customer, 60)),
      title: `${r.so_number} · ${clean(r.customer, 60)}`,
      detail: `${detail.replace(/\.+$/, '')}.`,
      severity: flags.length === 1 && flags[0] === 'high_value' ? 'low' : maxSev(...sev),
      flags,
      recommendation,
      data: {
        status: r.status,
        customer: clean(r.customer, 80),
        orderDate: r.order_date,
        promisedDate: r.promised_date,
        daysLate,
        total: r.total,
        discountPct: r.discount_pct,
        note,
      },
    });
  }

  const attention = items.filter((i) => i.flags.some((f) => f !== 'high_value'));
  const openValue = rows.reduce((s, r) => s + r.total, 0);
  const figures: Figure[] = [
    { label: 'Open sales orders', value: rows.length },
    { label: 'Open order value', value: formatInr(openValue) },
    { label: 'Orders needing attention', value: attention.length },
    { label: 'Delayed (promise date passed)', value: counts.delayed },
    { label: 'Due today', value: counts.dueToday },
    { label: 'Waiting for stock', value: counts.stock },
    { label: 'Waiting for customer approval', value: counts.customerApproval },
    { label: 'Waiting for Checker approval', value: counts.checker },
    { label: 'Waiting for warehouse dispatch', value: counts.dispatch },
    { label: 'Blocked', value: counts.blocked },
    { label: 'Unusual discounts (≥20%)', value: counts.discount },
    { label: 'High-value open orders (≥₹5 lakh)', value: counts.highValue },
  ];

  const parts = [
    counts.delayed && `${counts.delayed} delayed`,
    counts.stock && `${counts.stock} waiting for stock`,
    counts.customerApproval && `${counts.customerApproval} waiting for customer approval`,
    counts.checker && `${counts.checker} waiting for Checker approval`,
    counts.dispatch && `${counts.dispatch} waiting for dispatch`,
    counts.blocked && `${counts.blocked} blocked`,
  ].filter(Boolean);

  return finish('getOpenSalesOrders', {
    headline: attention.length
      ? `${plural(attention.length, 'sales order')} need attention out of ${rows.length} open (${parts.join(', ') || 'see items'}).`
      : `No open sales orders need attention (${rows.length} open).`,
    period: { from: today, to: today, description: `As of today (${today})` },
    figures,
    sections: [section('orders', 'Sales orders needing attention', items, ctx.maxRecords)],
    assumptions: [
      'An order is "delayed" when its promised date is before today and it has not been dispatched.',
      `Unusual discount means ${UNUSUAL_DISCOUNT_PCT}% or more; high value means ${formatInr(HIGH_VALUE_ORDER)} or more.`,
      ...(params.minAmount !== undefined ? [`Filtered to orders worth more than ${formatInr(params.minAmount)}.`] : []),
    ],
  });
}

// ---------------------------------------------------------- one sales order

export function getSalesOrderDetail(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getSalesOrderDetail');
  const today = istDate(ctx.now);
  const ref = (params.ref ?? '').trim().toUpperCase();
  const period = { from: today, to: today, description: `As of today (${today})` };

  const so = ctx.db
    .prepare(
      `SELECT s.id, s.so_number, s.status, s.order_date, s.promised_date, s.total, s.discount_pct,
              s.blocked_reason, s.waiting_note, c.id AS customer_id, c.name AS customer, c.credit_limit
         FROM sales_orders s JOIN customers c ON c.id = s.customer_id AND c.client_id = s.client_id
        WHERE s.client_id = ? AND s.so_number = ?`,
    )
    .get(ctx.clientId, ref) as
    | (SoRow & { id: number; customer_id: number; credit_limit: number })
    | undefined;

  if (!so) {
    return finish('getSalesOrderDetail', {
      headline: ref ? `No sales order ${ref} was found for your company.` : 'No sales order number was provided.',
      period,
      figures: [],
      sections: [section('order', 'Sales order', [], ctx.maxRecords)],
      assumptions: [],
      notFound: ref ? [ref] : [],
    });
  }

  const reservesStock = ['open', 'waiting_dispatch', 'waiting_customer_approval', 'waiting_checker_approval', 'blocked'].includes(so.status);
  const lines = ctx.db
    .prepare(
      `SELECT p.id AS product_id, p.sku, p.name, l.qty, p.stock_on_hand, p.reserved_qty, p.quarantined_qty, p.damaged_qty
         FROM sales_order_lines l JOIN products p ON p.id = l.product_id AND p.client_id = l.client_id
        WHERE l.client_id = ? AND l.sales_order_id = ?`,
    )
    .all(ctx.clientId, so.id) as {
    product_id: number; sku: string; name: string; qty: number;
    stock_on_hand: number; reserved_qty: number; quarantined_qty: number; damaged_qty: number;
  }[];

  const lineFacts = lines.map((l) => {
    const sellable = Math.max(0, l.stock_on_hand - l.reserved_qty - l.quarantined_qty - l.damaged_qty);
    const availableForOrder = sellable + (reservesStock ? l.qty : 0);
    return { ...l, sellable, availableForOrder, shortfall: Math.max(0, l.qty - availableForOrder) };
  });

  const reasons: string[] = [];
  const related: ToolItem[] = [];
  const statusText = SO_STATUS_TEXT[so.status] ?? so.status;
  const daysLate = Math.max(0, diffDays(today, so.promised_date));
  const flags: string[] = [so.status];
  let severity: Severity = 'low';

  // ---- explanation of the current status
  if (so.status === 'waiting_stock') {
    severity = 'high';
    const short = lineFacts.filter((l) => l.shortfall > 0);
    reasons.push(
      short.length
        ? `The order is waiting for stock: ${short
            .map((l) => `${l.sku} (${clean(l.name, 40)}) needs ${l.qty} but only ${l.availableForOrder} are sellable, short by ${l.shortfall}`)
            .join('; ')}.`
        : 'The order is marked as waiting for stock, but current sellable stock covers every line; allocation may need to be re-run in the Sales Orders queue.',
    );
    for (const l of short) {
      const inbound = ctx.db
        .prepare(
          `SELECT po.po_number, po.expected_date, sup.name AS supplier, (pl.qty - pl.received_qty) AS outstanding
             FROM purchase_order_lines pl
             JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.client_id = pl.client_id
             JOIN suppliers sup ON sup.id = po.supplier_id AND sup.client_id = po.client_id
            WHERE pl.client_id = ? AND pl.product_id = ? AND po.status IN ('approved','partially_received')
              AND pl.qty > pl.received_qty
            ORDER BY po.expected_date`,
        )
        .all(ctx.clientId, l.product_id) as { po_number: string; expected_date: string; supplier: string; outstanding: number }[];
      if (!inbound.length) {
        reasons.push(`No open purchase order covers the ${l.sku} shortage; Procurement may need to raise one.`);
      }
      for (const p of inbound) {
        const late = diffDays(today, p.expected_date);
        const timing = late > 0 ? `expected ${p.expected_date}, ${daysText(late)} late` : `expected ${p.expected_date}`;
        if (canAccessRecord(ctx.role, 'purchase-orders')) {
          reasons.push(`${p.po_number} (${clean(p.supplier, 60)}) has ${p.outstanding} units of ${l.sku} outstanding, ${timing}.`);
          related.push({
            ref: p.po_number,
            source: sourceRef('purchase-orders', p.po_number, clean(p.supplier, 60)),
            title: `${p.po_number} · ${clean(p.supplier, 60)}`,
            detail: `Inbound supply for ${l.sku}: ${p.outstanding} units outstanding, ${timing}.`,
            severity: late > 0 ? 'high' : 'low',
            flags: [late > 0 ? 'supplier_delay' : 'inbound'],
            recommendation: late > 0 ? 'Chase the supplier for a firm delivery date in the Procurement queue.' : undefined,
            data: { supplier: clean(p.supplier, 60), outstanding: p.outstanding, expectedDate: p.expected_date, daysLate: Math.max(0, late) },
          });
        } else {
          reasons.push(`Inbound supply for ${l.sku}: ${p.outstanding} units on an open purchase order, ${timing}.`);
        }
      }
    }
  } else if (so.status === 'waiting_customer_approval') {
    severity = 'medium';
    reasons.push(
      `The order is waiting for the customer's approval; it was created ${daysText(Math.max(0, diffDays(today, so.order_date)))} ago.${
        so.waiting_note ? ` ${clean(so.waiting_note, 200)}` : ''
      }`,
    );
  } else if (so.status === 'waiting_checker_approval') {
    severity = 'medium';
    reasons.push(`The order is waiting for Checker approval.${so.waiting_note ? ` ${clean(so.waiting_note, 200)}` : ''}`);
  } else if (so.status === 'waiting_dispatch') {
    severity = so.promised_date <= today ? 'high' : 'medium';
    reasons.push('Picking is complete and the order is waiting for warehouse dispatch.');
  } else if (so.status === 'blocked') {
    severity = 'high';
    reasons.push(`The order is blocked: ${clean(so.blocked_reason, 260) || 'no reason recorded'}`);
  } else if (so.status === 'open') {
    reasons.push('The order is open and not blocked.');
  } else {
    reasons.push(`The order status is ${statusText}.`);
  }

  if (so.promised_date < today && ['open', 'waiting_stock', 'waiting_dispatch', 'waiting_customer_approval', 'waiting_checker_approval', 'blocked'].includes(so.status)) {
    flags.push('delayed');
    severity = 'high';
    reasons.push(`It was promised for ${so.promised_date} and is ${daysText(daysLate)} late.`);
  } else {
    reasons.push(`Promised date: ${so.promised_date}.`);
  }

  // ---- customer credit (role-restricted)
  const hidden: string[] = [];
  let customerFacts: Record<string, unknown> = {};
  if (canSeeField(ctx.role, 'customer_credit')) {
    const bal = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(amount - paid_amount),0) AS outstanding,
                COALESCE(SUM(CASE WHEN due_date < ? THEN amount - paid_amount ELSE 0 END),0) AS overdue
           FROM invoices WHERE client_id = ? AND customer_id = ? AND status NOT IN ('paid','cancelled')`,
      )
      .get(today, ctx.clientId, so.customer_id) as { outstanding: number; overdue: number };
    customerFacts = { creditLimit: so.credit_limit, outstanding: bal.outstanding, overdue: bal.overdue };
    if (so.status === 'blocked' || bal.outstanding > so.credit_limit) {
      reasons.push(
        `${clean(so.customer, 60)} has ${formatInr(bal.outstanding)} outstanding (${formatInr(bal.overdue)} overdue) against a credit limit of ${formatInr(so.credit_limit)}.`,
      );
    }
  } else {
    hidden.push('customer credit and balances');
  }

  // ---- related records the role may open
  if (canAccessRecord(ctx.role, 'invoices')) {
    const invs = ctx.db
      .prepare(
        `SELECT invoice_number, due_date, amount - paid_amount AS balance FROM invoices
          WHERE client_id = ? AND (sales_order_id = ? OR (customer_id = ? AND due_date < ? AND status NOT IN ('paid','cancelled')))
          ORDER BY due_date`,
      )
      .all(ctx.clientId, so.id, so.customer_id, today) as { invoice_number: string; due_date: string; balance: number }[];
    for (const i of invs.filter((x) => x.balance > 0.005 && x.due_date < today).slice(0, 5)) {
      const late = diffDays(today, i.due_date);
      related.push({
        ref: i.invoice_number,
        source: sourceRef('invoices', i.invoice_number, clean(so.customer, 60)),
        title: `${i.invoice_number} · ${clean(so.customer, 60)}`,
        detail: `Overdue invoice for the same customer: ${formatInr(i.balance)} outstanding, ${daysText(late)} overdue.`,
        severity: late >= 30 ? 'high' : 'medium',
        flags: ['overdue_invoice'],
        recommendation: 'Chase the payment in Invoices & collections.',
        data: { balance: i.balance, daysOverdue: late },
      });
    }
  }
  if (canAccessRecord(ctx.role, 'approvals')) {
    const apps = ctx.db
      .prepare(
        `SELECT approval_ref, status, exception_note FROM approvals
          WHERE client_id = ? AND entity_ref = ? AND status IN ('pending','exception')`,
      )
      .all(ctx.clientId, so.so_number) as { approval_ref: string; status: string; exception_note: string | null }[];
    for (const a of apps) {
      reasons.push(`Approval ${a.approval_ref} is ${a.status}${a.exception_note ? `: ${clean(a.exception_note, 120)}` : ''}.`);
      related.push({
        ref: a.approval_ref,
        source: sourceRef('approvals', a.approval_ref),
        title: `${a.approval_ref} · approval for ${so.so_number}`,
        detail: `Approval is ${a.status}${a.exception_note ? `: ${clean(a.exception_note, 120)}` : ''}.`,
        severity: 'medium',
        flags: [a.status],
        recommendation: 'Follow the existing Checker approval process.',
        data: { status: a.status },
      });
    }
  }
  if (canAccessRecord(ctx.role, 'warehouse-tasks')) {
    const tasks = ctx.db
      .prepare(`SELECT task_number, task_type, status, due_date FROM warehouse_tasks WHERE client_id = ? AND sales_order_id = ? AND status <> 'done'`)
      .all(ctx.clientId, so.id) as { task_number: string; task_type: string; status: string; due_date: string }[];
    for (const t of tasks) {
      const late = diffDays(today, t.due_date);
      reasons.push(`Warehouse task ${t.task_number} (${t.task_type}) is ${t.status.replace('_', ' ')}${late > 0 ? ` and ${daysText(late)} overdue` : ''}.`);
      related.push({
        ref: t.task_number,
        source: sourceRef('warehouse-tasks', t.task_number),
        title: `${t.task_number} · ${t.task_type}`,
        detail: `Warehouse ${t.task_type} task is ${t.status.replace('_', ' ')}, due ${t.due_date}${late > 0 ? ` (${daysText(late)} overdue)` : ''}.`,
        severity: late > 0 ? 'high' : 'low',
        flags: [late > 0 ? 'overdue' : 'open'],
        data: { dueDate: t.due_date, daysOverdue: Math.max(0, late) },
      });
    }
  }

  const recommendation =
    so.status === 'waiting_stock'
      ? 'Open the Sales Orders queue, confirm the short SKUs and follow up the delayed purchase order in the Procurement queue.'
      : so.status === 'blocked'
        ? 'Resolve the cause shown (for example overdue invoices) or request an exception through the existing Checker approval process.'
        : so.status === 'waiting_customer_approval'
          ? 'Follow up with the customer to obtain sign-off.'
          : so.status === 'waiting_dispatch'
            ? 'Ask the warehouse to dispatch from the Warehouse queue.'
            : undefined;

  const main: ToolItem = {
    ref: so.so_number,
    source: sourceRef('sales-orders', so.so_number, clean(so.customer, 60)),
    title: `${so.so_number} · ${clean(so.customer, 60)}`,
    detail: reasons.join(' '),
    severity,
    flags,
    recommendation,
    data: {
      status: so.status,
      customer: clean(so.customer, 80),
      orderDate: so.order_date,
      promisedDate: so.promised_date,
      daysLate,
      total: so.total,
      discountPct: so.discount_pct,
      lines: lineFacts.map((l) => ({
        sku: l.sku,
        product: clean(l.name, 60),
        ordered: l.qty,
        sellable: l.availableForOrder,
        shortBy: l.shortfall,
      })),
      ...customerFacts,
    },
  };

  return finish('getSalesOrderDetail', {
    headline: `${so.so_number} is ${statusText}.`,
    period,
    figures: [
      { label: 'Order value', value: formatInr(so.total) },
      { label: 'Promised date', value: so.promised_date },
      { label: 'Order lines', value: lines.length },
      ...(lineFacts.some((l) => l.shortfall > 0)
        ? [{ label: 'Units short across lines', value: lineFacts.reduce((s, l) => s + l.shortfall, 0) } as Figure]
        : []),
    ],
    sections: [section('order', 'Sales order', [main], ctx.maxRecords), section('related', 'Related records', related, ctx.maxRecords)],
    assumptions: [
      'Sellable stock = stock on hand − reserved − quarantined − damaged.',
      'Only open purchase orders (approved or partially received) are counted as inbound supply.',
    ],
    hiddenForRole: hidden,
  });
}

// ----------------------------------------------------------------- invoices

export function getOverdueInvoices(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getOverdueInvoices');
  const today = istDate(ctx.now);

  const all = ctx.db
    .prepare(
      `SELECT i.invoice_number, i.issue_date, i.due_date, i.amount, i.paid_amount, c.name AS customer, c.credit_limit
         FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.client_id = i.client_id
        WHERE i.client_id = ? AND i.status NOT IN ('paid','cancelled') AND i.amount - i.paid_amount > 0.005
        ORDER BY i.due_date`,
    )
    .all(ctx.clientId) as {
    invoice_number: string; issue_date: string; due_date: string; amount: number; paid_amount: number; customer: string; credit_limit: number;
  }[];

  const totalReceivables = all.reduce((s, r) => s + (r.amount - r.paid_amount), 0);
  const overdueAll = all.filter((r) => r.due_date < today);
  const overdue = overdueAll.filter(
    (r) =>
      (params.minAmount === undefined || r.amount - r.paid_amount > params.minAmount) &&
      (params.maxAmount === undefined || r.amount - r.paid_amount < params.maxAmount) &&
      includesCI(r.customer, params.customer),
  );

  const items: ToolItem[] = overdue.map((r) => {
    const balance = r.amount - r.paid_amount;
    const late = diffDays(today, r.due_date);
    let severity: Severity = late >= 30 ? 'high' : late >= 7 ? 'medium' : 'low';
    if (balance >= 200_000 && severity !== 'high') severity = severity === 'low' ? 'medium' : 'high';
    return {
      ref: r.invoice_number,
      source: sourceRef('invoices', r.invoice_number, clean(r.customer, 60)),
      title: `${r.invoice_number} · ${clean(r.customer, 60)}`,
      detail: `${r.invoice_number} for ${clean(r.customer, 80)}: ${formatInr(balance)} outstanding${r.paid_amount > 0 ? ` (of ${formatInr(r.amount)}, ${formatInr(r.paid_amount)} received)` : ''}, ${daysText(late)} overdue (due ${r.due_date}).`,
      severity,
      flags: ['overdue'],
      recommendation:
        severity === 'high'
          ? `Escalate collection with ${clean(r.customer, 60)} and review credit exposure before accepting new orders.`
          : `Send a payment reminder to ${clean(r.customer, 60)}.`,
      data: { customer: clean(r.customer, 80), balance, amount: r.amount, daysOverdue: late, dueDate: r.due_date },
    };
  });

  // Customer roll-up (follow-up recommendations)
  const byCustomer = new Map<string, { total: number; count: number; oldest: (typeof overdue)[number]; limit: number }>();
  for (const r of overdue) {
    const e = byCustomer.get(r.customer);
    const bal = r.amount - r.paid_amount;
    if (e) {
      e.total += bal; e.count += 1;
      if (r.due_date < e.oldest.due_date) e.oldest = r;
    } else {
      byCustomer.set(r.customer, { total: bal, count: 1, oldest: r, limit: r.credit_limit });
    }
  }
  const showCredit = canSeeField(ctx.role, 'customer_credit');
  const customerItems: ToolItem[] = [...byCustomer.entries()].map(([name, e]) => {
    const late = diffDays(today, e.oldest.due_date);
    return {
      ref: e.oldest.invoice_number,
      source: sourceRef('invoices', e.oldest.invoice_number, clean(name, 60)),
      title: `${clean(name, 60)} · overdue balance`,
      detail: `${clean(name, 80)} has ${formatInr(e.total)} overdue across ${plural(e.count, 'invoice')}; the oldest (${e.oldest.invoice_number}) is ${daysText(late)} overdue${showCredit ? `. Credit limit ${formatInr(e.limit)}` : ''}.`,
      severity: late >= 30 ? 'high' : 'medium',
      flags: ['customer_followup'],
      recommendation: `Call ${clean(name, 60)} about the oldest invoice (${e.oldest.invoice_number}) and agree a payment date.`,
      data: { customer: clean(name, 80), overdueTotal: e.total, invoices: e.count, oldestDaysOverdue: late, ...(showCredit ? { creditLimit: e.limit } : {}) },
    };
  });

  const overdueTotal = overdue.reduce((s, r) => s + (r.amount - r.paid_amount), 0);
  const above1L = overdueAll.filter((r) => r.amount - r.paid_amount > 100_000).length;
  const figures: Figure[] = [
    { label: 'Overdue invoices', value: overdue.length },
    { label: 'Total overdue (outstanding balance)', value: formatInr(overdueTotal) },
    { label: 'Overdue invoices above ₹1 lakh (all customers)', value: above1L },
    { label: 'Customers with overdue balances', value: byCustomer.size },
    { label: 'Total open receivables', value: formatInr(totalReceivables) },
  ];

  return finish('getOverdueInvoices', {
    headline: overdue.length
      ? `${plural(overdue.length, 'invoice')} ${overdue.length === 1 ? 'is' : 'are'} overdue with ${formatInr(overdueTotal)} outstanding${params.minAmount !== undefined ? ` (balances above ${formatInr(params.minAmount)})` : ''}.`
      : `No overdue invoices${params.minAmount !== undefined ? ` above ${formatInr(params.minAmount)}` : ''} were found.`,
    period: { from: today, to: today, description: `As of today (${today})` },
    figures,
    sections: [
      section('invoices', 'Overdue invoices', items, ctx.maxRecords),
      section('customers', 'Customer follow-ups', customerItems, ctx.maxRecords),
    ],
    assumptions: [
      'Overdue means the due date is before today and an unpaid balance remains.',
      'Amounts are outstanding balances (invoice amount minus receipts recorded in WhizUnik).',
      ...(params.minAmount !== undefined ? [`Only invoices with an outstanding balance above ${formatInr(params.minAmount)} are listed.`] : []),
    ],
    hiddenForRole: showCredit ? [] : ['customer credit limits'],
  });
}

// --------------------------------------------------------------- inventory

interface ProductMetric {
  id: number; sku: string; name: string; category: string | null;
  onHand: number; reserved: number; quarantined: number; damaged: number; sellable: number;
  reorderLevel: number; unitCost: number; units30: number; avgDaily: number; daysCover: number | null;
  inbound: number; inboundPos: { po: string; expected: string; daysLate: number; qty: number; supplier: string }[];
}

function productMetrics(ctx: ToolContext, today: string): ProductMetric[] {
  const since = addDays(today, -30);
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.category, p.stock_on_hand, p.reserved_qty, p.quarantined_qty, p.damaged_qty,
              p.reorder_level, p.unit_cost,
              (SELECT COALESCE(SUM(h.qty),0) FROM sales_history h
                WHERE h.client_id = p.client_id AND h.product_id = p.id AND h.sale_date >= ? AND h.sale_date <= ?) AS units30
         FROM products p WHERE p.client_id = ? AND p.status = 'active' ORDER BY p.sku`,
    )
    .all(since, today, ctx.clientId) as {
    id: number; sku: string; name: string; category: string | null; stock_on_hand: number; reserved_qty: number;
    quarantined_qty: number; damaged_qty: number; reorder_level: number; unit_cost: number; units30: number;
  }[];

  const inboundRows = ctx.db
    .prepare(
      `SELECT pl.product_id, po.po_number, po.expected_date, sup.name AS supplier, (pl.qty - pl.received_qty) AS outstanding
         FROM purchase_order_lines pl
         JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.client_id = pl.client_id
         JOIN suppliers sup ON sup.id = po.supplier_id AND sup.client_id = po.client_id
        WHERE pl.client_id = ? AND po.status IN ('approved','partially_received') AND pl.qty > pl.received_qty
        ORDER BY po.expected_date`,
    )
    .all(ctx.clientId) as { product_id: number; po_number: string; expected_date: string; supplier: string; outstanding: number }[];

  return rows.map((r) => {
    const sellable = Math.max(0, r.stock_on_hand - r.reserved_qty - r.quarantined_qty - r.damaged_qty);
    const avgDaily = r.units30 / 30;
    const inboundPos = inboundRows
      .filter((i) => i.product_id === r.id)
      .map((i) => ({ po: i.po_number, expected: i.expected_date, daysLate: Math.max(0, diffDays(today, i.expected_date)), qty: i.outstanding, supplier: i.supplier }));
    return {
      id: r.id, sku: r.sku, name: r.name, category: r.category,
      onHand: r.stock_on_hand, reserved: r.reserved_qty, quarantined: r.quarantined_qty, damaged: r.damaged_qty,
      sellable, reorderLevel: r.reorder_level, unitCost: r.unit_cost, units30: r.units30, avgDaily,
      daysCover: avgDaily > 0 ? sellable / avgDaily : null,
      inbound: inboundPos.reduce((s, i) => s + i.qty, 0),
      inboundPos,
    };
  });
}

const STOPWORDS = new Set(['pack', 'of', 'set', 'the', 'and', 'pcs', 'pc', 'piece', 'pieces', 'combo']);

/** Lower-case, drop punctuation and filler words, then join: "Bamboo Tooth Brush Pack - 4" -> "bambootoothbrush4". */
export function normaliseProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join('');
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}

const MAX_DUPLICATE_GROUP = 1500;

function trigramJaccard(ta: Set<string>, tb: Set<string>): number {
  let inter = 0;
  ta.forEach((g) => tb.has(g) && inter++);
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

export function nameSimilarity(a: string, b: string): number {
  const x = normaliseProductName(a);
  const y = normaliseProductName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return trigramJaccard(trigrams(x), trigrams(y));
}

export function getLowStockProducts(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getLowStockProducts');
  const today = istDate(ctx.now);
  const horizon = Math.min(Math.max(Math.round(params.horizonDays ?? 30), 1), 365);
  const horizonEnd = addDays(today, horizon);
  const focus = params.focus ?? 'all';
  const want = (...f: string[]) => focus === 'all' || f.includes(focus);
  const showCost = canSeeField(ctx.role, 'unit_cost');
  const showPo = canAccessRecord(ctx.role, 'purchase-orders');
  const hidden: string[] = [];
  if (!showCost) hidden.push('unit costs and stock value');
  if (!showPo) hidden.push('purchase order numbers');

  const metrics = productMetrics(ctx, today);
  const poText = (m: ProductMetric): string => {
    if (!m.inbound) return 'Nothing is on order.';
    const first = m.inboundPos[0];
    const late = first.daysLate > 0 ? `, ${daysText(first.daysLate)} late` : '';
    return `${m.inbound} units on order${showPo ? ` (${first.po}, expected ${first.expected}${late})` : ` (expected ${first.expected}${late})`}.`;
  };
  const itemBase = (m: ProductMetric) => ({
    ref: m.sku,
    source: sourceRef('products', m.sku, clean(m.name, 60)),
    title: `${m.sku} · ${clean(m.name, 60)}`,
  });

  // 1. stock-out risk -------------------------------------------------------
  const stockOut: ToolItem[] = [];
  for (const m of metrics) {
    const demand = m.avgDaily > 0;
    const atRisk = (demand && m.daysCover !== null && m.daysCover <= horizon) || (m.sellable === 0 && demand);
    if (!atRisk) continue;
    const cover = m.daysCover ?? 0;
    const runOut = addDays(today, Math.floor(cover));
    const severity: Severity = m.sellable === 0 || cover <= 7 ? 'high' : cover <= 14 ? 'medium' : 'low';
    stockOut.push({
      ...itemBase(m),
      detail: `${m.sku} (${clean(m.name, 60)}): ${m.sellable} sellable, selling about ${m.avgDaily.toFixed(1)}/day, so ${m.sellable === 0 ? 'it is out of sellable stock now' : `it may run out around ${runOut} (~${Math.floor(cover)} days of cover)`}. ${poText(m)}`,
      severity,
      flags: ['stock_out_risk', ...(m.sellable < m.reorderLevel ? ['below_reorder_level'] : [])],
      recommendation: m.inbound
        ? 'Check the inbound purchase order delivery date in the Procurement queue and expedite if late.'
        : 'Raise a purchase order through the Procurement workflow.',
      data: { sellable: m.sellable, onHand: m.onHand, reserved: m.reserved, avgDailySales: Number(m.avgDaily.toFixed(2)), daysOfCover: Number(cover.toFixed(1)), expectedRunOutDate: runOut, onOrder: m.inbound, reorderLevel: m.reorderLevel },
    });
  }

  // 2. reorder recommendations ---------------------------------------------
  const reorder: ToolItem[] = [];
  for (const m of metrics) {
    const target = Math.max(m.reorderLevel, Math.ceil(m.avgDaily * 45));
    const position = m.sellable + m.inbound;
    const below = position < m.reorderLevel || (m.avgDaily > 0 && position / m.avgDaily < 21);
    if (!below) continue;
    const qty = Math.ceil((target - position) / 10) * 10;
    if (qty <= 0) continue;
    reorder.push({
      ...itemBase(m),
      detail: `${m.sku}: ${m.sellable} sellable + ${m.inbound} on order vs reorder level ${m.reorderLevel}; suggest ordering about ${qty} units to cover ~45 days of sales${showCost ? ` (estimated ${formatInr(qty * m.unitCost)} at last cost)` : ''}.`,
      severity: m.sellable === 0 ? 'high' : m.sellable < m.reorderLevel ? 'medium' : 'low',
      flags: ['reorder'],
      recommendation: 'Create the purchase order in the Procurement workflow; it will follow the normal approval process.',
      data: { sellable: m.sellable, onOrder: m.inbound, reorderLevel: m.reorderLevel, suggestedOrderQty: qty, avgDailySales: Number(m.avgDaily.toFixed(2)), ...(showCost ? { estimatedCost: qty * m.unitCost } : {}) },
    });
  }

  // 3. slow / fast movers -----------------------------------------------------
  const slow: ToolItem[] = [];
  for (const m of metrics) {
    if (m.sellable <= 0) continue;
    if (m.units30 <= 8 && (m.daysCover === null || m.daysCover > 120)) {
      slow.push({
        ...itemBase(m),
        detail: `${m.sku} (${clean(m.name, 60)}): ${m.units30} units sold in 30 days with ${m.sellable} sellable${m.daysCover === null ? ' (no recent sales)' : ` (~${Math.round(m.daysCover)} days of cover)`}${showCost ? `; about ${formatInr(m.sellable * m.unitCost)} of stock at cost` : ''}.`,
        severity: m.units30 === 0 ? 'medium' : 'low',
        flags: ['slow_moving'],
        recommendation: 'Review pricing, promotion or liquidation options; avoid reordering.',
        data: { units30d: m.units30, sellable: m.sellable, daysOfCover: m.daysCover === null ? null : Math.round(m.daysCover), ...(showCost ? { stockValueAtCost: m.sellable * m.unitCost } : {}) },
      });
    }
  }
  const fast: ToolItem[] = [...metrics]
    .filter((m) => m.avgDaily >= 1)
    .sort((a, b) => b.units30 - a.units30)
    .slice(0, 3)
    .map((m) => ({
      ...itemBase(m),
      detail: `${m.sku} (${clean(m.name, 60)}) is a fast mover: ${m.units30} units sold in 30 days (~${m.avgDaily.toFixed(1)}/day), ${m.sellable} sellable.`,
      severity: 'low' as Severity,
      flags: ['fast_moving'],
      data: { units30d: m.units30, avgDailySales: Number(m.avgDaily.toFixed(2)), sellable: m.sellable },
    }));

  // 4. duplicates -------------------------------------------------------------
  // Only computed when the question asks for it, compared within a category, with normalised names and
  // trigram sets prepared once (the naive all-pairs version stalls the server on large catalogues).
  const duplicates: ToolItem[] = [];
  if (want('duplicates')) {
    const prepared = metrics.map((m) => {
      const norm = normaliseProductName(m.name);
      return { m, norm, tri: trigrams(norm) };
    });
    const groups = new Map<string, typeof prepared>();
    for (const pr of prepared) groups.set(pr.m.category ?? '', [...(groups.get(pr.m.category ?? '') ?? []), pr]);
    for (const group of groups.values()) {
      if (group.length > MAX_DUPLICATE_GROUP) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const x = group[i];
          const y = group[j];
          const sim = x.norm && x.norm === y.norm ? 1 : trigramJaccard(x.tri, y.tri);
          if (sim < 0.85) continue;
          const a1 = x.m;
          const b1 = y.m;
          duplicates.push({
            ...itemBase(a1),
            detail: `${a1.sku} (${clean(a1.name, 60)}) and ${b1.sku} (${clean(b1.name, 60)}) look like the same product (name similarity ${(sim * 100).toFixed(0)}%). Combined stock is ${a1.onHand + b1.onHand} units.`,
            severity: 'medium',
            flags: ['duplicate_candidate'],
            recommendation: 'Review both SKUs in Inventory and merge or retire one through the existing product workflow.',
            data: { otherSku: b1.sku, otherName: clean(b1.name, 60), similarityPct: Math.round(sim * 100) },
          });
        }
      }
    }
  }

  // 5. unusual movements ------------------------------------------------------
  const unusual: ToolItem[] = [];
  const movements = ctx.db
    .prepare(
      `SELECT m.id, m.movement_date, m.type, m.qty, m.reference, m.note, p.sku, p.name, p.stock_on_hand
         FROM stock_movements m JOIN products p ON p.id = m.product_id AND p.client_id = m.client_id
        WHERE m.client_id = ? AND m.movement_date >= ? AND m.type IN ('adjustment','damage','write_off')
        ORDER BY m.movement_date DESC`,
    )
    .all(ctx.clientId, addDays(today, -30)) as {
    movement_date: string; type: string; qty: number; reference: string | null; note: string | null; sku: string; name: string; stock_on_hand: number;
  }[];
  const counts = ctx.db
    .prepare(
      `SELECT p.sku, c.count_date, c.system_qty, c.counted_qty
         FROM cycle_counts c JOIN products p ON p.id = c.product_id AND p.client_id = c.client_id
        WHERE c.client_id = ? AND c.status = 'open' AND c.counted_qty <> c.system_qty`,
    )
    .all(ctx.clientId) as { sku: string; count_date: string; system_qty: number; counted_qty: number }[];
  const flaggedSkus = new Set<string>();
  for (const mv of movements) {
    const abs = Math.abs(mv.qty);
    if (!(abs >= 50 || (abs >= 10 && mv.stock_on_hand > 0 && abs / mv.stock_on_hand >= 0.25))) continue;
    flaggedSkus.add(mv.sku);
    const cc = counts.find((c) => c.sku === mv.sku);
    unusual.push({
      ref: mv.sku,
      source: sourceRef('products', mv.sku, clean(mv.name, 60)),
      title: `${mv.sku} · ${clean(mv.name, 60)}`,
      detail: `${mv.sku}: a ${mv.type} of ${mv.qty > 0 ? '+' : ''}${mv.qty} units on ${mv.movement_date} (${clean(mv.reference, 40)}${mv.note ? `; ${clean(mv.note, 120)}` : ''}) is large compared with ${mv.stock_on_hand} on hand.${cc ? ` A cycle count on ${cc.count_date} found ${cc.counted_qty} against ${cc.system_qty} in the system.` : ''}`,
      severity: abs >= 100 ? 'high' : 'medium',
      flags: ['unusual_movement'],
      recommendation: 'Have the warehouse recount and confirm the reason; any correction must go through the Checker approval process.',
      data: { movementType: mv.type, qty: mv.qty, date: mv.movement_date, onHand: mv.stock_on_hand },
    });
  }
  for (const c of counts) {
    const diff = c.counted_qty - c.system_qty;
    if (flaggedSkus.has(c.sku) || Math.abs(diff) < 10) continue;
    const p = metrics.find((m) => m.sku === c.sku);
    if (!p) continue;
    unusual.push({
      ...itemBase(p),
      detail: `${c.sku}: cycle count on ${c.count_date} found ${c.counted_qty} against ${c.system_qty} in the system (${diff > 0 ? '+' : ''}${diff}).`,
      severity: 'medium',
      flags: ['count_discrepancy'],
      data: { systemQty: c.system_qty, countedQty: c.counted_qty, difference: diff },
    });
  }

  const sections: ToolSection[] = [];
  const max = ctx.maxRecords;
  if (want('stockout')) sections.push(section('stockOutRisk', `Stock-out risk (next ${horizon} days)`, stockOut, max), section('reorder', 'Reorder recommendations', reorder, max));
  if (want('slow')) sections.push(section('slowMoving', 'Slow-moving SKUs', slow, max), section('fastMoving', 'Fast-moving SKUs', fast, max));
  if (want('duplicates')) sections.push(section('duplicates', 'Possible duplicate products', duplicates, max));
  if (want('movements')) sections.push(section('unusualMovements', 'Unusual stock movements', unusual, max));

  const figures: Figure[] = [
    { label: 'Active SKUs analysed', value: metrics.length },
    { label: `SKUs at risk of stock-out within ${horizon} days`, value: stockOut.length },
    { label: 'SKUs needing reorder', value: reorder.length },
    { label: 'Slow-moving SKUs', value: slow.length },
    { label: 'Possible duplicate pairs', value: duplicates.length },
    { label: 'Unusual stock movements', value: unusual.length },
  ];

  const headline =
    focus === 'slow'
      ? `${plural(slow.length, 'SKU')} ${slow.length === 1 ? 'is' : 'are'} slow-moving; ${fast.map((f) => f.ref).join(', ') || 'none'} ${fast.length === 1 ? 'is the fastest mover' : 'are the fastest movers'}.`
      : focus === 'duplicates'
        ? `${plural(duplicates.length, 'possible duplicate product pair')} found.`
        : focus === 'movements'
          ? `${plural(unusual.length, 'unusual stock movement')} found in the last 30 days.`
          : `${plural(stockOut.length, 'SKU')} ${stockOut.length === 1 ? 'is' : 'are'} at risk of running out within ${daysText(horizon)} (by ${horizonEnd}); ${plural(reorder.length, 'SKU')} ${reorder.length === 1 ? 'needs' : 'need'} reordering.`;

  return finish('getLowStockProducts', {
    headline,
    period: { from: today, to: horizonEnd, description: `Next ${horizon} days (${today} to ${horizonEnd}); sales trend from the last 30 days` },
    figures,
    sections,
    assumptions: [
      'Sellable stock = stock on hand − reserved for open orders − quarantined − damaged.',
      'Average daily sales = units sold in the last 30 days ÷ 30; days of cover = sellable stock ÷ average daily sales.',
      'Open purchase orders (approved / partially received) count as stock on order; delivery dates are as promised by the supplier.',
      'Suggested reorder quantity targets about 45 days of sales, rounded up to the nearest 10.',
    ],
    hiddenForRole: hidden,
  });
}

// ------------------------------------------------------------- procurement

export function getDelayedPurchaseOrders(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getDelayedPurchaseOrders');
  const today = istDate(ctx.now);
  const showPricing = canSeeField(ctx.role, 'supplier_pricing');
  const canSeeSo = canAccessRecord(ctx.role, 'sales-orders');
  const hidden = showPricing ? [] : ['supplier pricing and PO values'];

  const delayed = (
    ctx.db
      .prepare(
        `SELECT po.id, po.po_number, po.status, po.order_date, po.expected_date, po.total, sup.name AS supplier
           FROM purchase_orders po JOIN suppliers sup ON sup.id = po.supplier_id AND sup.client_id = po.client_id
          WHERE po.client_id = ? AND po.status IN ('approved','partially_received') AND po.expected_date < ?
          ORDER BY po.expected_date`,
      )
      .all(ctx.clientId, today) as { id: number; po_number: string; status: string; order_date: string; expected_date: string; total: number; supplier: string }[]
  ).filter((p) => includesCI(p.supplier, params.supplier));

  const metrics = productMetrics(ctx, today);
  const poItems: ToolItem[] = [];
  const shortage: ToolItem[] = [];
  for (const po of delayed) {
    const lines = ctx.db
      .prepare(
        `SELECT p.id AS product_id, p.sku, p.name, pl.qty, pl.received_qty, pl.unit_price
           FROM purchase_order_lines pl JOIN products p ON p.id = pl.product_id AND p.client_id = pl.client_id
          WHERE pl.client_id = ? AND pl.purchase_order_id = ?`,
      )
      .all(ctx.clientId, po.id) as { product_id: number; sku: string; name: string; qty: number; received_qty: number; unit_price: number }[];
    const outstanding = lines.filter((l) => l.qty > l.received_qty);
    const outQty = outstanding.reduce((s, l) => s + (l.qty - l.received_qty), 0);
    const outValue = outstanding.reduce((s, l) => s + (l.qty - l.received_qty) * l.unit_price, 0);
    const late = diffDays(today, po.expected_date);

    const waiting = ctx.db
      .prepare(
        `SELECT DISTINCT s.so_number FROM sales_orders s JOIN sales_order_lines l ON l.sales_order_id = s.id AND l.client_id = s.client_id
          WHERE s.client_id = ? AND s.status = 'waiting_stock' AND l.product_id IN (${outstanding.map(() => '?').join(',') || 'NULL'})`,
      )
      .all(ctx.clientId, ...outstanding.map((l) => l.product_id)) as { so_number: string }[];

    const severity: Severity = late >= 10 || waiting.length > 0 ? 'high' : late >= 3 ? 'medium' : 'low';
    poItems.push({
      ref: po.po_number,
      source: sourceRef('purchase-orders', po.po_number, clean(po.supplier, 60)),
      title: `${po.po_number} · ${clean(po.supplier, 60)}`,
      detail: `${po.po_number} (${clean(po.supplier, 60)}) was expected on ${po.expected_date} and is ${daysText(late)} late: ${outQty} units outstanding (${outstanding.map((l) => l.sku).join(', ')})${showPricing ? `, about ${formatInr(outValue)}` : ''}.${waiting.length ? ` ${plural(waiting.length, 'sales order')} ${waiting.length === 1 ? 'is' : 'are'} waiting for this stock${canSeeSo ? ` (${waiting.map((w) => w.so_number).join(', ')})` : ''}.` : ''}`,
      severity,
      flags: ['delayed', ...(waiting.length ? ['blocking_sales_orders'] : [])],
      recommendation: 'Contact the supplier for a firm delivery date from the Procurement queue; consider partial delivery or an alternate supplier.',
      data: { supplier: clean(po.supplier, 60), expectedDate: po.expected_date, daysLate: late, outstandingQty: outQty, status: po.status, salesOrdersWaiting: waiting.length, ...(showPricing ? { outstandingValue: outValue } : {}) },
    });

    for (const l of outstanding) {
      const m = metrics.find((x) => x.id === l.product_id);
      if (m && m.daysCover !== null && m.daysCover <= 14) {
        shortage.push({
          ref: m.sku,
          source: sourceRef('products', m.sku, clean(m.name, 60)),
          title: `${m.sku} · ${clean(m.name, 60)}`,
          detail: `${m.sku} has about ${Math.floor(m.daysCover)} days of cover (${m.sellable} sellable) but ${po.po_number} is ${daysText(late)} late.`,
          severity: m.daysCover <= 7 ? 'high' : 'medium',
          flags: ['stock_shortage_warning'],
          recommendation: 'Expedite the delayed purchase order or source from another supplier.',
          data: { sellable: m.sellable, daysOfCover: Number(m.daysCover.toFixed(1)), delayedPo: po.po_number, poDaysLate: late },
        });
      }
    }
  }

  // Supplier delivery performance (history of received POs + currently delayed POs)
  const history = ctx.db
    .prepare(
      `SELECT sup.id, sup.name, po.po_number, po.expected_date, po.received_date
         FROM purchase_orders po JOIN suppliers sup ON sup.id = po.supplier_id AND sup.client_id = po.client_id
        WHERE po.client_id = ? AND po.status = 'received' AND po.received_date IS NOT NULL`,
    )
    .all(ctx.clientId) as { id: number; name: string; po_number: string; expected_date: string; received_date: string }[];
  const suppliers = new Map<string, { delayedOpen: string[]; lateDays: number[]; lastPo: string }>();
  for (const h of history) {
    const e = suppliers.get(h.name) ?? { delayedOpen: [], lateDays: [], lastPo: h.po_number };
    e.lateDays.push(Math.max(0, diffDays(h.received_date, h.expected_date)));
    e.lastPo = h.po_number;
    suppliers.set(h.name, e);
  }
  for (const d of delayed) {
    const e = suppliers.get(d.supplier) ?? { delayedOpen: [], lateDays: [], lastPo: d.po_number };
    e.delayedOpen.push(d.po_number);
    suppliers.set(d.supplier, e);
  }
  const supplierItems: ToolItem[] = [];
  for (const [name, e] of suppliers) {
    if (!includesCI(name, params.supplier)) continue;
    const avg = e.lateDays.length ? e.lateDays.reduce((a, b) => a + b, 0) / e.lateDays.length : 0;
    if (e.delayedOpen.length === 0 && avg === 0) continue;
    const ref = e.delayedOpen[0] ?? e.lastPo;
    supplierItems.push({
      ref,
      source: sourceRef('purchase-orders', ref, clean(name, 60)),
      title: `${clean(name, 60)} · delivery performance`,
      detail: `${clean(name, 60)}: ${plural(e.delayedOpen.length, 'open PO')} currently delayed${e.delayedOpen.length ? ` (${e.delayedOpen.join(', ')})` : ''}; ${e.lateDays.length ? `past deliveries averaged ${avg.toFixed(1)} days late across ${plural(e.lateDays.length, 'received PO')}` : 'no delivery history yet'}.`,
      severity: e.delayedOpen.length ? 'high' : avg >= 5 ? 'medium' : 'low',
      flags: ['supplier_delay'],
      recommendation: 'Review supplier performance before placing the next order.',
      data: { supplier: clean(name, 60), delayedOpenPos: e.delayedOpen.length, historicalAvgDaysLate: Number(avg.toFixed(1)), receivedPos: e.lateDays.length },
    });
  }

  // Price increases and comparisons (only for roles allowed to see supplier pricing)
  const priceIncreases: ToolItem[] = [];
  const priceComparison: ToolItem[] = [];
  if (showPricing) {
    const prices = ctx.db
      .prepare(
        `SELECT sp.supplier_id, sup.name AS supplier, sp.product_id, p.sku, p.name AS product, sp.price_date, sp.unit_price
           FROM supplier_prices sp
           JOIN suppliers sup ON sup.id = sp.supplier_id AND sup.client_id = sp.client_id
           JOIN products p ON p.id = sp.product_id AND p.client_id = sp.client_id
          WHERE sp.client_id = ? ORDER BY sp.price_date`,
      )
      .all(ctx.clientId) as { supplier_id: number; supplier: string; product_id: number; sku: string; product: string; price_date: string; unit_price: number }[];

    const byPair = new Map<string, typeof prices>();
    for (const p of prices) {
      const k = `${p.supplier_id}:${p.product_id}`;
      byPair.set(k, [...(byPair.get(k) ?? []), p]);
    }
    const latestByProduct = new Map<number, { supplier: string; price: number; date: string; sku: string; product: string }[]>();
    for (const list of byPair.values()) {
      const last = list[list.length - 1];
      const prev = list[list.length - 2];
      latestByProduct.set(last.product_id, [
        ...(latestByProduct.get(last.product_id) ?? []),
        { supplier: last.supplier, price: last.unit_price, date: last.price_date, sku: last.sku, product: last.product },
      ]);
      if (prev && last.unit_price >= prev.unit_price * 1.1 && includesCI(last.supplier, params.supplier)) {
        const pct = ((last.unit_price - prev.unit_price) / prev.unit_price) * 100;
        const openPo = ctx.db
          .prepare(
            `SELECT po.po_number FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.client_id = pl.client_id
              WHERE pl.client_id = ? AND pl.product_id = ? AND po.supplier_id = ? AND po.status <> 'cancelled' ORDER BY po.order_date DESC LIMIT 1`,
          )
          .get(ctx.clientId, last.product_id, last.supplier_id) as { po_number: string } | undefined;
        const alt = prices
          .filter((x) => x.product_id === last.product_id && x.supplier_id !== last.supplier_id)
          .sort((a, b) => b.price_date.localeCompare(a.price_date))[0];
        priceIncreases.push({
          ref: openPo?.po_number ?? last.sku,
          source: openPo ? sourceRef('purchase-orders', openPo.po_number, clean(last.supplier, 60)) : sourceRef('products', last.sku, clean(last.product, 60)),
          title: `${last.sku} · ${clean(last.supplier, 60)} price increase`,
          detail: `${clean(last.supplier, 60)} raised the price of ${last.sku} (${clean(last.product, 40)}) from ${formatInr(prev.unit_price)} to ${formatInr(last.unit_price)} (+${pct.toFixed(1)}%) on ${last.price_date}.${alt ? ` ${clean(alt.supplier, 60)} quoted ${formatInr(alt.unit_price)} on ${alt.price_date}.` : ''}`,
          severity: pct >= 20 ? 'high' : 'medium',
          flags: ['unusual_price_increase'],
          recommendation: alt ? `Compare with ${clean(alt.supplier, 60)} and negotiate before the next order.` : 'Negotiate with the supplier or request alternative quotes.',
          data: { supplier: clean(last.supplier, 60), previousPrice: prev.unit_price, latestPrice: last.unit_price, increasePct: Number(pct.toFixed(1)), ...(alt ? { alternativeSupplier: clean(alt.supplier, 60), alternativePrice: alt.unit_price } : {}) },
        });
      }
    }
    for (const [productId, quotes] of latestByProduct) {
      if (quotes.length < 2) continue;
      const sorted = [...quotes].sort((a, b) => a.price - b.price);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const diffPct = ((worst.price - best.price) / best.price) * 100;
      const sku = best.sku;
      priceComparison.push({
        ref: sku,
        source: sourceRef('products', sku, clean(best.product, 60)),
        title: `${sku} · supplier price comparison`,
        detail: `${sku} (${clean(best.product, 40)}): ${sorted.map((q) => `${clean(q.supplier, 40)} ${formatInr(q.price)}`).join(' vs ')}; the cheapest quote is ${diffPct.toFixed(1)}% lower than the most expensive.`,
        severity: diffPct >= 10 ? 'medium' : 'low',
        flags: ['price_comparison'],
        data: { quotes: sorted.map((q) => ({ supplier: clean(q.supplier, 40), price: q.price, date: q.date })), productId },
      });
    }
  }

  const maxLate = delayed.reduce((m, p) => Math.max(m, diffDays(today, p.expected_date)), 0);
  const figures: Figure[] = [
    { label: 'Delayed purchase orders', value: delayed.length },
    { label: 'Suppliers with delayed POs', value: new Set(delayed.map((d) => d.supplier)).size },
    { label: 'Longest delay (days)', value: maxLate },
    ...(showPricing ? [{ label: 'Outstanding value on delayed POs', value: formatInr(poItems.reduce((s, i) => s + Number(i.data.outstandingValue ?? 0), 0)) } as Figure] : []),
    { label: 'Stock shortage warnings', value: shortage.length },
  ];

  return finish('getDelayedPurchaseOrders', {
    headline: delayed.length
      ? `${plural(delayed.length, 'purchase order')} ${delayed.length === 1 ? 'is' : 'are'} delayed (longest ${daysText(maxLate)}); ${plural(shortage.length, 'stock shortage warning')}.`
      : 'No purchase orders are delayed.',
    period: { from: today, to: today, description: `As of today (${today})` },
    figures,
    sections: [
      section('delayedPos', 'Delayed purchase orders', poItems, ctx.maxRecords),
      section('supplierPerformance', 'Supplier delivery performance', supplierItems, ctx.maxRecords),
      section('shortages', 'Stock shortage warnings', shortage, ctx.maxRecords),
      ...(showPricing
        ? [section('priceIncreases', 'Unusual price increases (≥10%)', priceIncreases, ctx.maxRecords), section('priceComparison', 'Supplier price comparison', priceComparison, ctx.maxRecords)]
        : []),
    ],
    assumptions: [
      'A purchase order is delayed when it is approved or partially received and its expected date is before today.',
      'Historical lateness uses the received date versus the expected date on received purchase orders.',
      'A price increase is flagged when the latest quote is at least 10% above the previous quote from the same supplier.',
    ],
    hiddenForRole: hidden,
  });
}

// --------------------------------------------------------------- warehouse

export function getPendingWarehouseTasks(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getPendingWarehouseTasks');
  const today = istDate(ctx.now);
  const tomorrow = addDays(today, 1);

  const tasks = ctx.db
    .prepare(
      `SELECT t.task_number, t.task_type, t.status, t.priority, t.due_date, t.assigned_to, t.note,
              s.so_number, s.promised_date, po.po_number, p.sku
         FROM warehouse_tasks t
         LEFT JOIN sales_orders s ON s.id = t.sales_order_id AND s.client_id = t.client_id
         LEFT JOIN purchase_orders po ON po.id = t.purchase_order_id AND po.client_id = t.client_id
         LEFT JOIN products p ON p.id = t.product_id AND p.client_id = t.client_id
        WHERE t.client_id = ? AND t.status <> 'done'
        ORDER BY t.due_date, t.task_number`,
    )
    .all(ctx.clientId) as {
    task_number: string; task_type: string; status: string; priority: string; due_date: string; assigned_to: string | null;
    note: string | null; so_number: string | null; promised_date: string | null; po_number: string | null; sku: string | null;
  }[];

  const taskItems: ToolItem[] = [];
  const dispatchItems: ToolItem[] = [];
  const workload = new Map<string, { open: number; overdue: number }>();
  for (const t of tasks) {
    const late = diffDays(today, t.due_date);
    const w = workload.get(t.assigned_to ?? 'Unassigned') ?? { open: 0, overdue: 0 };
    w.open++;
    if (late > 0) w.overdue++;
    workload.set(t.assigned_to ?? 'Unassigned', w);

    const target = [t.so_number, t.po_number, t.sku].filter(Boolean).join(' / ');
    let severity: Severity = t.priority === 'urgent' || late > 0 ? 'high' : t.due_date === today ? 'medium' : 'low';
    if (t.task_type === 'dispatch' && t.due_date <= today) severity = 'high';
    const item: ToolItem = {
      ref: t.task_number,
      source: sourceRef('warehouse-tasks', t.task_number, `${t.task_type.replace('_', ' ')}${target ? ` ${target}` : ''}`),
      title: `${t.task_number} · ${t.task_type.replace('_', ' ')}${target ? ` ${target}` : ''}`,
      detail: `${t.task_number}: ${t.task_type.replace('_', ' ')}${target ? ` for ${target}` : ''}, ${t.status.replace('_', ' ')}, assigned to ${clean(t.assigned_to, 40) || 'nobody'}, due ${t.due_date}${late > 0 ? ` (${daysText(late)} overdue)` : t.due_date === today ? ' (today)' : ''}, priority ${t.priority}.${t.promised_date ? ` Customer promise date ${t.promised_date}.` : ''}${t.note ? ` ${clean(t.note, 140)}` : ''}`,
      severity,
      flags: [t.task_type, ...(late > 0 ? ['overdue'] : []), ...(t.priority === 'urgent' ? ['urgent'] : [])],
      recommendation:
        t.task_type === 'dispatch'
          ? 'Complete dispatch in the Warehouse queue and update the courier booking.'
          : t.task_type === 'pick'
            ? 'Pick in order of customer promise date.'
            : undefined,
      data: { type: t.task_type, status: t.status, priority: t.priority, dueDate: t.due_date, daysOverdue: Math.max(0, late), assignedTo: clean(t.assigned_to, 40), salesOrder: t.so_number, customerPromiseDate: t.promised_date },
    };
    taskItems.push(item);
    if (t.task_type === 'dispatch' && t.due_date <= tomorrow) dispatchItems.push(item);
  }

  // Picking priority: SO promise date, then priority
  const pickOrder = taskItems
    .filter((i) => i.data.type === 'pick' && i.data.status !== 'done')
    .sort((a, b) => String(a.data.customerPromiseDate ?? '9999').localeCompare(String(b.data.customerPromiseDate ?? '9999')));

  const discrepancyRows = ctx.db
    .prepare(
      `SELECT p.sku, p.name, c.count_date, c.system_qty, c.counted_qty
         FROM cycle_counts c JOIN products p ON p.id = c.product_id AND p.client_id = c.client_id
        WHERE c.client_id = ? AND c.status = 'open' AND c.counted_qty <> c.system_qty`,
    )
    .all(ctx.clientId) as { sku: string; name: string; count_date: string; system_qty: number; counted_qty: number }[];
  const discrepancies: ToolItem[] = discrepancyRows.map((c) => {
    const diff = c.counted_qty - c.system_qty;
    const pct = (Math.abs(diff) / Math.max(1, c.system_qty)) * 100;
    return {
      ref: c.sku,
      source: sourceRef('products', c.sku, clean(c.name, 60)),
      title: `${c.sku} · ${clean(c.name, 60)}`,
      detail: `${c.sku}: cycle count on ${c.count_date} found ${c.counted_qty} against ${c.system_qty} in the system (${diff > 0 ? '+' : ''}${diff}, ${pct.toFixed(0)}%).`,
      severity: Math.abs(diff) >= 50 || pct >= 20 ? 'high' : 'low',
      flags: ['stock_discrepancy'],
      recommendation: 'Recount and raise any stock correction through the Checker approval process.',
      data: { systemQty: c.system_qty, countedQty: c.counted_qty, difference: diff, countDate: c.count_date },
    };
  });

  const qrows = ctx.db
    .prepare(
      `SELECT sku, name, stock_on_hand, quarantined_qty, damaged_qty FROM products
        WHERE client_id = ? AND (quarantined_qty > 0 OR damaged_qty > 0) ORDER BY sku`,
    )
    .all(ctx.clientId) as { sku: string; name: string; stock_on_hand: number; quarantined_qty: number; damaged_qty: number }[];
  const quarantined: ToolItem[] = qrows.map((p) => ({
    ref: p.sku,
    source: sourceRef('products', p.sku, clean(p.name, 60)),
    title: `${p.sku} · ${clean(p.name, 60)}`,
    detail: `${p.sku}: ${p.quarantined_qty} quarantined and ${p.damaged_qty} damaged out of ${p.stock_on_hand} on hand.`,
    severity: p.quarantined_qty + p.damaged_qty >= 15 ? 'medium' : 'low',
    flags: ['quarantined_or_damaged'],
    recommendation: 'Complete the quality check and decide on release, return to supplier or write-off through the approval process.',
    data: { quarantined: p.quarantined_qty, damaged: p.damaged_qty, onHand: p.stock_on_hand },
  }));

  const overdueCount = tasks.filter((t) => diffDays(today, t.due_date) > 0).length;
  const figures: Figure[] = [
    { label: 'Open warehouse tasks', value: tasks.length },
    { label: 'Overdue tasks', value: overdueCount },
    { label: 'Dispatches due by tomorrow', value: dispatchItems.length },
    { label: 'Open stock discrepancies', value: discrepancies.length },
    { label: 'SKUs with quarantined or damaged stock', value: quarantined.length },
    ...[...workload.entries()].slice(0, 8).map(([name, w]) => ({ label: `Workload: ${clean(name, 30)}`, value: `${w.open} open, ${w.overdue} overdue` })),
  ];

  return finish('getPendingWarehouseTasks', {
    headline: tasks.length
      ? `${plural(tasks.length, 'warehouse task')} ${tasks.length === 1 ? 'is' : 'are'} open: ${overdueCount} overdue, ${dispatchItems.length} dispatch(es) due by tomorrow.`
      : 'There are no open warehouse tasks.',
    period: { from: today, to: tomorrow, description: `As of today (${today}); dispatch deadlines through ${tomorrow}` },
    figures,
    sections: [
      section('tasks', 'Open warehouse tasks', taskItems, ctx.maxRecords),
      section('dispatchDeadlines', 'Dispatch deadlines (due by tomorrow)', dispatchItems, ctx.maxRecords),
      section('pickingPriority', 'Picking priority (by customer promise date)', pickOrder, ctx.maxRecords),
      section('discrepancies', 'Stock discrepancies', discrepancies, ctx.maxRecords),
      section('quarantined', 'Damaged and quarantined inventory', quarantined, ctx.maxRecords),
    ],
    assumptions: ['A task is overdue when its due date is before today and it is not done.', 'Picking priority follows the linked sales order promise date.'],
  });
}

// ------------------------------------------------------------- marketplace

export function getMarketplaceExceptions(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getMarketplaceExceptions');
  const today = istDate(ctx.now);
  const showSettlements = canSeeField(ctx.role, 'settlement_values');
  const mp = params.marketplace;

  const orders = (
    ctx.db
      .prepare(
        `SELECT m.order_ref, m.marketplace, m.marketplace_sku, m.qty, m.amount, m.status, m.order_date, m.return_reason, m.product_id, p.sku, p.name
           FROM marketplace_orders m LEFT JOIN products p ON p.id = m.product_id AND p.client_id = m.client_id
          WHERE m.client_id = ? AND m.status NOT IN ('cancelled')
          ORDER BY m.order_date DESC, m.order_ref`,
      )
      .all(ctx.clientId) as {
      order_ref: string; marketplace: string; marketplace_sku: string; qty: number; amount: number; status: string;
      order_date: string; return_reason: string | null; product_id: number | null; sku: string | null; name: string | null;
    }[]
  ).filter((o) => includesCI(o.marketplace, mp));

  // unmapped SKUs (group by marketplace + marketplace SKU)
  const unmappedGroups = new Map<string, typeof orders>();
  for (const o of orders.filter((x) => x.product_id === null)) {
    const k = `${o.marketplace}|${o.marketplace_sku}`;
    unmappedGroups.set(k, [...(unmappedGroups.get(k) ?? []), o]);
  }
  const unmapped: ToolItem[] = [...unmappedGroups.values()].map((g) => {
    const first = g[0];
    const units = g.reduce((s, o) => s + o.qty, 0);
    return {
      ref: first.order_ref,
      source: sourceRef('marketplace-orders', first.order_ref, `${first.marketplace} ${clean(first.marketplace_sku, 40)}`),
      title: `${clean(first.marketplace_sku, 40)} · ${first.marketplace} (unmapped)`,
      detail: `${clean(first.marketplace_sku, 40)} on ${first.marketplace} has no WhizUnik SKU mapping: ${plural(g.length, 'order')} (${units} units) are blocked (${g.map((o) => o.order_ref).join(', ')}).`,
      severity: g.length >= 2 ? 'high' : 'medium',
      flags: ['unmapped_sku'],
      recommendation: 'Map the marketplace SKU to the correct WhizUnik SKU in the Marketplace workflow so the orders can proceed.',
      data: { marketplace: first.marketplace, marketplaceSku: clean(first.marketplace_sku, 40), orders: g.length, units },
    };
  });

  const orderItem = (o: (typeof orders)[number], flag: string, text: string, sev: Severity, rec: string): ToolItem => ({
    ref: o.order_ref,
    source: sourceRef('marketplace-orders', o.order_ref, `${o.marketplace}`),
    title: `${o.order_ref} · ${o.marketplace}`,
    detail: `${o.order_ref} (${o.marketplace}, ${o.qty} × ${o.sku ?? clean(o.marketplace_sku, 40)}, ${formatInr(o.amount)}) ${text} (ordered ${o.order_date}).`,
    severity: sev,
    flags: [flag],
    recommendation: rec,
    data: { marketplace: o.marketplace, qty: o.qty, amount: o.amount, orderDate: o.order_date, ageDays: Math.max(0, diffDays(today, o.order_date)) },
  });

  const waitingStock = orders
    .filter((o) => o.status === 'waiting_stock')
    .map((o) => orderItem(o, 'waiting_stock', 'is waiting for stock', diffDays(today, o.order_date) >= 2 ? 'high' : 'medium', 'Check stock and inbound purchase orders for this SKU; replenish or cancel to protect the marketplace seller rating.'));
  const waitingInvoice = orders
    .filter((o) => o.status === 'waiting_invoice')
    .map((o) => orderItem(o, 'waiting_invoice', 'is waiting for an invoice', diffDays(today, o.order_date) >= 3 ? 'high' : diffDays(today, o.order_date) >= 2 ? 'medium' : 'low', 'Raise the invoice through the Finance workflow so the order can ship.'));

  // API failures (last 7 days)
  const since = new Date(ctx.now.getTime() - 7 * 86_400_000).toISOString();
  const failures = (
    ctx.db
      .prepare(
        `SELECT event_ref, marketplace, event_type, error_message, occurred_at FROM marketplace_api_events
          WHERE client_id = ? AND status = 'failed' AND occurred_at >= ? ORDER BY occurred_at DESC`,
      )
      .all(ctx.clientId, since) as { event_ref: string; marketplace: string; event_type: string; error_message: string | null; occurred_at: string }[]
  ).filter((e) => includesCI(e.marketplace, mp));
  const apiFailures: ToolItem[] = failures.map((e) => {
    const hours = Math.max(0, Math.round((ctx.now.getTime() - Date.parse(e.occurred_at)) / 3_600_000));
    return {
      ref: e.event_ref,
      source: sourceRef('api-events', e.event_ref, `${e.marketplace} ${e.event_type}`),
      title: `${e.event_ref} · ${e.marketplace} ${e.event_type}`,
      detail: `${e.marketplace} ${e.event_type} failed ${hours} hour(s) ago: ${clean(e.error_message, 160) || 'no message'}.`,
      severity: hours <= 24 ? 'high' : 'medium',
      flags: ['api_failure'],
      recommendation: 'Check the marketplace connection in the Marketplace workflow; retry or reconnect, and escalate to IT if it persists.',
      data: { marketplace: e.marketplace, eventType: e.event_type, hoursAgo: hours },
    };
  });

  // Return risk (last 60 days, per SKU)
  const since60 = addDays(today, -60);
  const bySku = new Map<string, { sku: string; name: string; total: number; returned: number; reasons: Map<string, number>; markets: Set<string> }>();
  for (const o of orders.filter((x) => x.sku && x.order_date >= since60)) {
    const e = bySku.get(o.sku!) ?? { sku: o.sku!, name: o.name ?? '', total: 0, returned: 0, reasons: new Map(), markets: new Set() };
    e.total++;
    e.markets.add(o.marketplace);
    if (o.status === 'returned') {
      e.returned++;
      const r = clean(o.return_reason, 80) || 'no reason given';
      e.reasons.set(r, (e.reasons.get(r) ?? 0) + 1);
    }
    bySku.set(o.sku!, e);
  }
  const returnRisk: ToolItem[] = [];
  for (const e of bySku.values()) {
    const rate = (e.returned / e.total) * 100;
    if (e.total >= 5 && rate >= 25) {
      const top = [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      returnRisk.push({
        ref: e.sku,
        source: sourceRef('products', e.sku, clean(e.name, 60)),
        title: `${e.sku} · ${clean(e.name, 60)} (return risk)`,
        detail: `${e.sku}: ${e.returned} of ${e.total} marketplace orders in the last 60 days were returned (${rate.toFixed(1)}%) on ${[...e.markets].join(', ')}${top ? `; most common reason: "${top[0]}"` : ''}.`,
        severity: rate >= 35 ? 'high' : 'medium',
        flags: ['return_risk'],
        recommendation: 'Review the listing content and quality for this SKU before further marketplace promotion.',
        data: { orders60d: e.total, returned: e.returned, returnRatePct: Number(rate.toFixed(1)) },
      });
    }
  }

  // Settlements (role-restricted)
  const settlementItems: ToolItem[] = [];
  let shortfallTotal = 0;
  const hidden: string[] = [];
  if (showSettlements) {
    const rows = (
      ctx.db
        .prepare(
          `SELECT settlement_ref, marketplace, expected_date, expected_amount, received_amount, status, note
             FROM marketplace_settlements WHERE client_id = ? ORDER BY expected_date`,
        )
        .all(ctx.clientId) as { settlement_ref: string; marketplace: string; expected_date: string; expected_amount: number; received_amount: number | null; status: string; note: string | null }[]
    ).filter((s) => includesCI(s.marketplace, mp));
    for (const s of rows) {
      const received = s.received_amount ?? 0;
      const diff = s.expected_amount - received;
      const late = diffDays(today, s.expected_date);
      if (s.status === 'short_paid' || (s.received_amount !== null && diff > 0.005)) {
        shortfallTotal += diff;
        settlementItems.push({
          ref: s.settlement_ref,
          source: sourceRef('settlements', s.settlement_ref, s.marketplace),
          title: `${s.settlement_ref} · ${s.marketplace}`,
          detail: `${s.settlement_ref} (${s.marketplace}): expected ${formatInr(s.expected_amount)}, received ${formatInr(received)}, difference ${formatInr(diff)}.${s.note ? ` ${clean(s.note, 140)}` : ''}`,
          severity: diff >= 10_000 ? 'high' : 'medium',
          flags: ['settlement_difference'],
          recommendation: 'Reconcile the marketplace fee statement and raise a claim for the shortfall in the Finance workflow.',
          data: { expected: s.expected_amount, received, difference: diff },
        });
      } else if (s.status === 'overdue' || (s.received_amount === null && late > 0)) {
        shortfallTotal += s.expected_amount;
        settlementItems.push({
          ref: s.settlement_ref,
          source: sourceRef('settlements', s.settlement_ref, s.marketplace),
          title: `${s.settlement_ref} · ${s.marketplace}`,
          detail: `${s.settlement_ref} (${s.marketplace}): ${formatInr(s.expected_amount)} was expected on ${s.expected_date} (${daysText(late)} ago) and nothing has been received.`,
          severity: 'high',
          flags: ['settlement_overdue'],
          recommendation: 'Contact the marketplace seller support and track the payout in the Finance workflow.',
          data: { expected: s.expected_amount, received: 0, daysLate: late },
        });
      }
    }
  } else {
    hidden.push('marketplace settlement amounts');
  }

  // PDF section 8: Finance covers "invoices, receipts, settlements and cash flow". For Finance this tool therefore
  // returns only orders waiting for an invoice and settlement differences; Management gets the full picture.
  const financeOnly = ctx.role === 'finance';
  if (financeOnly) hidden.push('marketplace SKU mapping, stock, API-failure and return-risk data (outside Finance access)');

  const blockedCount = unmapped.reduce((s, i) => s + Number(i.data.orders), 0) + waitingStock.length + waitingInvoice.length;
  const figures: Figure[] = financeOnly
    ? [
        { label: 'Orders waiting for an invoice', value: waitingInvoice.length },
        ...(showSettlements ? [{ label: 'Settlement shortfall / overdue amount', value: formatInr(shortfallTotal) } as Figure] : []),
      ]
    : [
    { label: 'Blocked marketplace orders (total)', value: blockedCount },
    { label: 'Orders with unmapped marketplace SKUs', value: unmapped.reduce((s, i) => s + Number(i.data.orders), 0) },
    { label: 'Unmapped marketplace SKUs', value: unmapped.length },
    { label: 'Orders waiting for stock', value: waitingStock.length },
    { label: 'Orders waiting for an invoice', value: waitingInvoice.length },
    { label: 'API failures (last 7 days)', value: apiFailures.length },
    { label: 'SKUs with high return risk', value: returnRisk.length },
    ...(showSettlements ? [{ label: 'Settlement shortfall / overdue amount', value: formatInr(shortfallTotal) } as Figure] : []),
  ];

  const settlementSection = showSettlements ? [section('settlementDifferences', 'Settlement differences', settlementItems, ctx.maxRecords)] : [];
  return finish('getMarketplaceExceptions', {
    headline: financeOnly
      ? `${plural(waitingInvoice.length, 'marketplace order')} ${waitingInvoice.length === 1 ? 'is' : 'are'} waiting for an invoice; settlements: ${formatInr(shortfallTotal)} short or overdue across ${plural(settlementItems.length, 'settlement')}.`
      : `${plural(blockedCount, 'marketplace order')} ${blockedCount === 1 ? 'is' : 'are'} blocked: ${unmapped.reduce((s, i) => s + Number(i.data.orders), 0)} unmapped SKU, ${waitingStock.length} waiting for stock, ${waitingInvoice.length} waiting for an invoice; ${plural(apiFailures.length, 'API failure')} in the last 7 days.`,
    period: { from: addDays(today, -60), to: today, description: `Open exceptions as of ${today}; API failures last 7 days; returns last 60 days` },
    figures,
    sections: financeOnly
      ? [section('waitingForInvoice', 'Orders waiting for an invoice', waitingInvoice, ctx.maxRecords), ...settlementSection]
      : [
      section('unmappedSkus', 'Unmapped marketplace SKUs', unmapped, ctx.maxRecords),
      section('waitingForStock', 'Orders waiting for stock', waitingStock, ctx.maxRecords),
      section('waitingForInvoice', 'Orders waiting for an invoice', waitingInvoice, ctx.maxRecords),
      section('apiFailures', 'Marketplace API failures', apiFailures, ctx.maxRecords),
      section('returnRisk', 'Return-risk SKUs', returnRisk, ctx.maxRecords),
      ...settlementSection,
    ],
    assumptions: financeOnly
      ? ['Settlement differences compare expected with received marketplace payouts; overdue means the expected date has passed with nothing received.']
      : [
          '"Blocked" marketplace orders are those with an unmapped SKU, waiting for stock, or waiting for an invoice.',
          'Return risk is flagged when at least 5 orders in 60 days exist for a SKU and 25% or more were returned.',
        ],
    hiddenForRole: hidden,
  });
}

// --------------------------------------------------------------- cash flow

export function getCashFlowSummary(ctx: ToolContext, params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getCashFlowSummary');
  const today = istDate(ctx.now);
  const from = params.from ?? today;
  const to = params.to ?? endOfMonth(today);
  const client = ctx.db.prepare('SELECT cash_balance FROM clients WHERE id = ?').get(ctx.clientId) as { cash_balance: number } | undefined;
  const opening = client?.cash_balance ?? 0;

  const receivables = ctx.db
    .prepare(
      `SELECT i.invoice_number, i.due_date, i.amount - i.paid_amount AS balance, c.name AS customer
         FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.client_id = i.client_id
        WHERE i.client_id = ? AND i.status NOT IN ('paid','cancelled') AND i.amount - i.paid_amount > 0.005
          AND i.due_date >= ? AND i.due_date <= ? ORDER BY i.due_date`,
    )
    .all(ctx.clientId, from, to) as { invoice_number: string; due_date: string; balance: number; customer: string }[];

  const overdueRecv = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(amount - paid_amount),0) AS total, COUNT(*) AS n FROM invoices
        WHERE client_id = ? AND status NOT IN ('paid','cancelled') AND amount - paid_amount > 0.005 AND due_date < ?`,
    )
    .get(ctx.clientId, from) as { total: number; n: number };

  const bills = ctx.db
    .prepare(
      `SELECT b.bill_number, b.due_date, b.amount - b.paid_amount AS balance, s.name AS supplier
         FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.client_id = b.client_id
        WHERE b.client_id = ? AND b.status <> 'paid' AND b.amount - b.paid_amount > 0.005 AND b.due_date <= ?
        ORDER BY b.due_date`,
    )
    .all(ctx.clientId, to) as { bill_number: string; due_date: string; balance: number; supplier: string }[];

  const settlements = ctx.db
    .prepare(
      `SELECT settlement_ref, marketplace, expected_date, expected_amount FROM marketplace_settlements
        WHERE client_id = ? AND status = 'pending' AND received_amount IS NULL AND expected_date >= ? AND expected_date <= ?
        ORDER BY expected_date`,
    )
    .all(ctx.clientId, from, to) as { settlement_ref: string; marketplace: string; expected_date: string; expected_amount: number }[];

  const items: { recv: ToolItem[]; pay: ToolItem[]; set: ToolItem[] } = { recv: [], pay: [], set: [] };
  for (const r of receivables) {
    items.recv.push({
      ref: r.invoice_number,
      source: sourceRef('invoices', r.invoice_number, clean(r.customer, 60)),
      title: `${r.invoice_number} · ${clean(r.customer, 60)}`,
      detail: `${formatInr(r.balance)} expected from ${clean(r.customer, 60)} (${r.invoice_number}) on ${r.due_date}.`,
      severity: 'low',
      flags: ['expected_inflow'],
      data: { amount: r.balance, dueDate: r.due_date, customer: clean(r.customer, 60) },
    });
  }
  let overduePayables = 0;
  for (const b of bills) {
    const late = diffDays(from, b.due_date);
    const isOverdue = b.due_date < from;
    if (isOverdue) overduePayables += b.balance;
    const soon = !isOverdue && diffDays(b.due_date, from) <= 7;
    items.pay.push({
      ref: b.bill_number,
      source: sourceRef('supplier-bills', b.bill_number, clean(b.supplier, 60)),
      title: `${b.bill_number} · ${clean(b.supplier, 60)}`,
      detail: `${formatInr(b.balance)} payable to ${clean(b.supplier, 60)} (${b.bill_number}) ${isOverdue ? `was due ${b.due_date} (${daysText(late)} overdue)` : `is due ${b.due_date}`}.`,
      severity: isOverdue ? 'high' : soon || b.balance >= 200_000 ? 'medium' : 'low',
      flags: [isOverdue ? 'overdue_payable' : 'upcoming_payment'],
      recommendation: 'Submit the payment through the Finance workflow; it will follow the Checker approval process.',
      data: { amount: b.balance, dueDate: b.due_date, supplier: clean(b.supplier, 60), overdue: isOverdue },
    });
  }
  for (const s of settlements) {
    items.set.push({
      ref: s.settlement_ref,
      source: sourceRef('settlements', s.settlement_ref, s.marketplace),
      title: `${s.settlement_ref} · ${s.marketplace}`,
      detail: `${formatInr(s.expected_amount)} expected from ${s.marketplace} settlement ${s.settlement_ref} on ${s.expected_date}.`,
      severity: 'low',
      flags: ['expected_inflow'],
      data: { amount: s.expected_amount, expectedDate: s.expected_date },
    });
  }

  const inRecv = receivables.reduce((s, r) => s + r.balance, 0);
  const inSet = settlements.reduce((s, r) => s + r.expected_amount, 0);
  const outPay = bills.reduce((s, b) => s + b.balance, 0);
  const inflow = inRecv + inSet;
  const net = inflow - outPay;
  const closing = opening + net;

  return finish('getCashFlowSummary', {
    headline: `Expected cash flow ${from} to ${to}: inflows ${formatInr(inflow)}, outflows ${formatInr(outPay)}, net ${formatInr(net)}; projected closing balance ${formatInr(closing)} from an opening ${formatInr(opening)}.`,
    period: { from, to, description: `${from} to ${to}` },
    figures: [
      { label: 'Opening cash balance', value: formatInr(opening) },
      { label: 'Expected customer receipts', value: formatInr(inRecv) },
      { label: 'Expected marketplace settlements', value: formatInr(inSet) },
      { label: 'Total expected inflows', value: formatInr(inflow) },
      { label: 'Supplier payments due (incl. overdue)', value: formatInr(outPay) },
      { label: 'of which already overdue', value: formatInr(overduePayables) },
      { label: 'Net cash flow', value: formatInr(net) },
      { label: 'Projected closing balance', value: formatInr(closing) },
      { label: 'Overdue receivables NOT counted as inflow', value: formatInr(overdueRecv.total) },
    ],
    sections: [
      section('payables', 'Supplier payments', items.pay, ctx.maxRecords),
      section('receivables', 'Expected customer receipts', items.recv, ctx.maxRecords),
      section('settlements', 'Expected marketplace settlements', items.set, ctx.maxRecords),
    ],
    assumptions: [
      `Opening balance is the latest cash balance recorded in WhizUnik Treasury (${formatInr(opening)}); it is not refreshed intraday.`,
      'Customer receipts are unpaid invoices whose due date falls in the period; overdue invoices are NOT assumed to be collected.',
      'Supplier payments include bills due in the period plus any already-overdue bills (assumed paid in the period).',
      'Marketplace settlements are counted on their expected payout date; short-paid or overdue settlements are excluded.',
    ],
  });
}

// ---------------------------------------------------------------- approvals

export function getPendingApprovals(ctx: ToolContext, _params: ToolParams = {}): ToolResult {
  requireTool(ctx, 'getPendingApprovals');
  const today = istDate(ctx.now);
  const rows = ctx.db
    .prepare(
      `SELECT approval_ref, entity_type, entity_ref, amount, submitted_at, status, exception_note
         FROM approvals WHERE client_id = ? AND status IN ('pending','exception') ORDER BY submitted_at`,
    )
    .all(ctx.clientId) as { approval_ref: string; entity_type: string; entity_ref: string; amount: number | null; submitted_at: string; status: string; exception_note: string | null }[];

  const items: ToolItem[] = rows.map((a) => {
    const hours = Math.max(0, Math.round((ctx.now.getTime() - Date.parse(a.submitted_at)) / 3_600_000));
    const label = a.entity_type.replace(/_/g, ' ');
    return {
      ref: a.approval_ref,
      source: sourceRef('approvals', a.approval_ref, `${label} ${a.entity_ref}`),
      title: `${a.approval_ref} · ${label} ${a.entity_ref}`,
      detail: `${a.approval_ref}: ${label} ${a.entity_ref}${a.amount ? ` (${formatInr(a.amount)})` : ''} submitted ${hours} hour(s) ago is ${a.status}${a.exception_note ? ` — ${clean(a.exception_note, 140)}` : ''}.`,
      severity: hours > 48 || a.status === 'exception' ? (hours > 48 ? 'high' : 'medium') : 'low',
      flags: [a.status, ...(hours > 48 ? ['aged'] : [])],
      recommendation: 'Review in the Checker approvals queue and follow the existing approval process; the AI cannot approve.',
      data: { entityType: a.entity_type, entityRef: a.entity_ref, status: a.status, hoursPending: hours, ...(a.amount ? { amount: a.amount } : {}) },
    };
  });
  const aged = items.filter((i) => i.flags.includes('aged')).length;
  const exceptions = rows.filter((r) => r.status === 'exception').length;
  const oldest = items.reduce((m, i) => Math.max(m, Number(i.data.hoursPending)), 0);

  return finish('getPendingApprovals', {
    headline: rows.length
      ? `${plural(rows.length, 'approval')} ${rows.length === 1 ? 'is' : 'are'} pending (${exceptions} exception(s), ${aged} waiting more than 48 hours).`
      : 'There are no pending approvals or exceptions.',
    period: { from: today, to: today, description: `As of today (${today})` },
    figures: [
      { label: 'Pending approvals and exceptions', value: rows.length },
      { label: 'Exceptions', value: exceptions },
      { label: 'Waiting more than 48 hours', value: aged },
      { label: 'Oldest pending (hours)', value: oldest },
    ],
    sections: [section('approvals', 'Pending approvals and exceptions', items, ctx.maxRecords)],
    assumptions: ['Approvals older than 48 hours are flagged as aged.'],
  });
}

// ---------------------------------------------------------------- registry

export const TOOL_REGISTRY: Record<ToolName, (ctx: ToolContext, params: ToolParams) => ToolResult> = {
  getOpenSalesOrders,
  getSalesOrderDetail,
  getOverdueInvoices,
  getLowStockProducts,
  getDelayedPurchaseOrders,
  getPendingWarehouseTasks,
  getMarketplaceExceptions,
  getCashFlowSummary,
  getPendingApprovals,
};

/** Run one approved tool. Callers must have passed the ToolGate first; the tool re-checks the role itself. */
export function runTool(name: ToolName, ctx: ToolContext, params: ToolParams = {}): ToolResult {
  const fn = TOOL_REGISTRY[name];
  if (!fn) throw new AppError('UNAUTHORISED_TOOL', 403, `Unknown tool ${String(name)}.`);
  return fn(ctx, params);
}
