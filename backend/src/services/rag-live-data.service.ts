import type { Db } from '../types';

export interface SupplierBillLine {
  billNumber: string;
  dueDate: string;
  amountInr: number;
  paidInr: number;
  outstandingInr: number;
  overdue: boolean;
}

export interface SupplierOutstandingResult {
  supplierName: string;
  /** Outstanding (unpaid) total of the bills in scope. */
  totalDueInr: number;
  bills: SupplierBillLine[];
  /** e.g. "this month (November 2026)"; null when no period was asked for. */
  periodLabel: string | null;
  /** Unpaid amount on this supplier's bills outside the requested period. */
  otherOpenTotalInr: number;
  asOf: string;
}

export type SupplierLookup =
  | { kind: 'found'; data: SupplierOutstandingResult }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'not_found' };

/** Calendar date (YYYY-MM-DD) in India Standard Time, matching how due dates are stored. */
function istDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export class RagLiveDataService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * What the company owes one supplier: unpaid supplier bills (amount − paid) for the authenticated client only.
   * Purchase orders are commitments, not amounts owed, so they are not counted.
   */
  getSupplierOutstanding(clientId: number, supplierName: string, opts: { period?: string; now?: Date } = {}): SupplierLookup {
    const name = supplierName.trim();
    if (!name) return { kind: 'not_found' };
    const now = opts.now ?? new Date();

    const exact = this.db
      .prepare('SELECT id, name FROM suppliers WHERE client_id = ? AND lower(name) = lower(?)')
      .all(clientId, name) as { id: number; name: string }[];
    const matches = exact.length
      ? exact
      : (this.db
          .prepare(`SELECT id, name FROM suppliers WHERE client_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name`)
          .all(clientId, `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { id: number; name: string }[]);

    if (matches.length === 0) return { kind: 'not_found' };
    if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.map((m) => m.name) };
    const supplier = matches[0];

    const today = istDate(now);
    const month = today.slice(0, 7);
    let inPeriod: (dueDate: string) => boolean = () => true;
    let periodLabel: string | null = null;
    if (opts.period === 'current month') {
      inPeriod = (d) => d.slice(0, 7) === month;
      periodLabel = `this month (${new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`;
    } else if (opts.period === 'overdue') {
      inPeriod = (d) => d < today;
      periodLabel = 'before today (overdue)';
    } else if (opts.period === 'today') {
      inPeriod = (d) => d === today;
      periodLabel = 'today';
    }

    const rows = this.db
      .prepare(`
        SELECT bill_number, due_date, amount, paid_amount
        FROM supplier_bills
        WHERE client_id = ? AND supplier_id = ? AND amount - paid_amount > 0.005 AND status != 'cancelled'
        ORDER BY due_date ASC, bill_number ASC
      `)
      .all(clientId, supplier.id) as { bill_number: string; due_date: string; amount: number; paid_amount: number }[];

    const lines: SupplierBillLine[] = rows.map((r) => ({
      billNumber: r.bill_number,
      dueDate: r.due_date,
      amountInr: r.amount,
      paidInr: r.paid_amount,
      outstandingInr: Math.round((r.amount - r.paid_amount) * 100) / 100,
      overdue: r.due_date < today,
    }));
    const bills = lines.filter((l) => inPeriod(l.dueDate));
    const sum = (ls: SupplierBillLine[]) => Math.round(ls.reduce((s, l) => s + l.outstandingInr, 0) * 100) / 100;

    return {
      kind: 'found',
      data: {
        supplierName: supplier.name,
        totalDueInr: sum(bills),
        bills,
        periodLabel,
        otherOpenTotalInr: sum(lines.filter((l) => !inPeriod(l.dueDate))),
        asOf: now.toISOString(),
      },
    };
  }
}
