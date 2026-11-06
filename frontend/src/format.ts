const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrFmt2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function inr(n: number | null | undefined, decimals = false): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const f = decimals ? inrFmt2 : inrFmt;
  return `${n < 0 ? '-' : ''}₹${f.format(Math.abs(n))}`;
}

/** Costs are tiny (fractions of a rupee) so show more precision. */
export function inrSmall(n: number): string {
  if (n === 0) return '₹0';
  return n < 1 ? `₹${n.toFixed(4)}` : inr(n, true);
}

export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : inrFmt.format(n);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? `${d}T00:00:00` : d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(d: string): string {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'grey';

export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (/(overdue|blocked|failed|exception|urgent|short_paid|provider_error|error|forbidden|blocked_limit|refused|high)/.test(s)) return 'red';
  if (/(waiting|pending|partially|medium|unknown|invalid)/.test(s)) return 'amber';
  if (/(done|paid|dispatched|invoiced|approved|received|delivered|success|ok|closed|shipped|active)/.test(s)) return 'green';
  if (/(open|in_progress|low|cached)/.test(s)) return 'blue';
  return 'grey';
}

export const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export const ROLE_LABEL: Record<string, string> = {
  management: 'Management',
  sales: 'Sales',
  procurement: 'Procurement',
  warehouse: 'Warehouse',
  finance: 'Finance',
  checker: 'Checker',
};

export const TOOL_LABEL: Record<string, string> = {
  getOpenSalesOrders: 'Open sales orders',
  getSalesOrderDetail: 'Sales order detail',
  getOverdueInvoices: 'Overdue invoices',
  getLowStockProducts: 'Stock & inventory',
  getDelayedPurchaseOrders: 'Delayed purchase orders',
  getPendingWarehouseTasks: 'Warehouse tasks',
  getMarketplaceExceptions: 'Marketplace exceptions',
  getCashFlowSummary: 'Cash flow',
  getPendingApprovals: 'Pending approvals',
};
