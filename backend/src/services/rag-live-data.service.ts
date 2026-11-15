import type { Db } from '../types';

export interface SupplierOutstandingResult {
  supplierName: string;
  totalDueInr: number;
  invoiceCount: number;
  invoices: {
    invoiceRef: string;
    dueDate: string;
    amountInr: number;
    status: string;
  }[];
  asOf: string;
}

export class RagLiveDataService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Query outstanding supplier balance for a tenant/company
   */
  getSupplierOutstanding(
    clientId: number,
    supplierName: string,
    now: Date = new Date(),
  ): SupplierOutstandingResult | null {
    // Check if supplier exists for this client
    const supplier = this.db
      .prepare('SELECT id, name FROM suppliers WHERE client_id = ? AND name LIKE ?')
      .get(clientId, `%${supplierName}%`) as { id: number; name: string } | undefined;

    if (!supplier) {
      // Check purchase orders or supplier bills
      const poRows = this.db
        .prepare(`
          SELECT po_number, total, expected_date, status
          FROM purchase_orders
          WHERE client_id = ? AND supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ? AND client_id = ?)
        `)
        .all(clientId, `%${supplierName}%`, clientId) as {
        po_number: string;
        total: number;
        expected_date: string;
        status: string;
      }[];

      if (poRows.length === 0) return null;

      const totalDue = poRows.reduce((sum, p) => sum + (p.total || 0), 0);
      return {
        supplierName,
        totalDueInr: totalDue,
        invoiceCount: poRows.length,
        invoices: poRows.map((p) => ({
          invoiceRef: p.po_number,
          dueDate: p.expected_date,
          amountInr: p.total,
          status: p.status,
        })),
        asOf: now.toISOString(),
      };
    }

    // Query invoices or bills for this supplier
    const rows = this.db
      .prepare(`
        SELECT po_number, total, expected_date, status
        FROM purchase_orders
        WHERE client_id = ? AND supplier_id = ? AND status != 'cancelled'
      `)
      .all(clientId, supplier.id) as {
      po_number: string;
      total: number;
      expected_date: string;
      status: string;
    }[];

    const totalDue = rows.reduce((sum, r) => sum + (r.total || 0), 0);

    return {
      supplierName: supplier.name,
      totalDueInr: totalDue,
      invoiceCount: rows.length,
      invoices: rows.map((r) => ({
        invoiceRef: r.po_number,
        dueDate: r.expected_date,
        amountInr: r.total,
        status: r.status,
      })),
      asOf: now.toISOString(),
    };
  }
}
