import { AppError } from '../errors';
import type { Db, RecordType, Role } from '../types';
import { RECORD_TYPES } from '../types';
import { diffDays, istDate } from '../utils/dates';
import { canAccessRecord, canSeeField } from './ai-permissions.service';
import { RECORD_META, sourceRef } from './record-links';

/**
 * Read-only record viewer. AI answers link here ("open the relevant WhizUnik
 * workflow"). In a full deployment these links would point at the existing
 * WhizUnik screens; here they give a small read-only view of the same records
 * so every recommendation can be traced and checked.
 *
 * Nothing in this module writes data: approvals and actions stay in the
 * existing WhizUnik workflows.
 */

export type ColumnKind = 'text' | 'number' | 'money' | 'date' | 'status' | 'datetime';

export interface Column {
  key: string;
  label: string;
  kind?: ColumnKind;
  /** Hidden for roles that may not see this data class. */
  hideUnless?: 'unit_cost' | 'supplier_pricing' | 'settlement_values' | 'customer_credit';
}

type Row = Record<string, string | number | null>;

interface Def {
  columns: Column[];
  /** SELECT that returns `ref` plus every column key. Must contain `WHERE <alias>.client_id = ?` and end without ORDER BY. */
  sql: string;
  refExpr: string;
  order: string;
  post?: (row: Row, today: string) => void;
  extra?: (db: Db, clientId: number, role: Role, row: Row, today: string) => { tables?: Table[]; related?: Related[] };
}

export interface Table {
  title: string;
  columns: Column[];
  rows: Row[];
}
export interface Related {
  type: RecordType;
  ref: string;
  label: string;
  link: string;
}

const rel = (type: RecordType, ref: string, note?: string): Related => ({ type, ref, label: note ? `${ref} · ${note}` : ref, link: sourceRef(type, ref).link });

const DEFS: Record<RecordType, Def> = {
  'sales-orders': {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'order_date', label: 'Order date', kind: 'date' },
      { key: 'promised_date', label: 'Promised', kind: 'date' },
      { key: 'days_late', label: 'Days late', kind: 'number' },
      { key: 'total', label: 'Total', kind: 'money' },
      { key: 'discount_pct', label: 'Discount %', kind: 'number' },
      { key: 'blocked_reason', label: 'Blocked reason' },
      { key: 'waiting_note', label: 'Note' },
    ],
    sql: `SELECT s.so_number AS ref, c.name AS customer, s.status, s.order_date, s.promised_date, s.total, s.discount_pct, s.blocked_reason, s.waiting_note
            FROM sales_orders s JOIN customers c ON c.id = s.customer_id AND c.client_id = s.client_id WHERE s.client_id = ?`,
    refExpr: 's.so_number',
    order: 's.promised_date, s.so_number',
    post: (r, today) => {
      const open = !['dispatched', 'invoiced', 'closed', 'cancelled'].includes(String(r.status));
      r.days_late = open ? Math.max(0, diffDays(today, String(r.promised_date))) : 0;
    },
    extra: (db, clientId, role, row) => {
      const tables: Table[] = [];
      const related: Related[] = [];
      const lines = db
        .prepare(
          `SELECT p.sku, p.name AS product, l.qty, l.unit_price, l.qty * l.unit_price AS line_total
             FROM sales_order_lines l JOIN sales_orders s ON s.id = l.sales_order_id AND s.client_id = l.client_id
             JOIN products p ON p.id = l.product_id AND p.client_id = l.client_id
            WHERE l.client_id = ? AND s.so_number = ?`,
        )
        .all(clientId, row.ref) as Row[];
      tables.push({
        title: 'Order lines',
        columns: [
          { key: 'sku', label: 'SKU' },
          { key: 'product', label: 'Product' },
          { key: 'qty', label: 'Qty', kind: 'number' },
          { key: 'unit_price', label: 'Unit price', kind: 'money' },
          { key: 'line_total', label: 'Line total', kind: 'money' },
        ],
        rows: lines,
      });
      if (canAccessRecord(role, 'invoices')) {
        for (const i of db
          .prepare(`SELECT i.invoice_number AS ref FROM invoices i JOIN sales_orders s ON s.id = i.sales_order_id AND s.client_id = i.client_id WHERE i.client_id = ? AND s.so_number = ?`)
          .all(clientId, row.ref) as { ref: string }[]) related.push(rel('invoices', i.ref));
      }
      if (canAccessRecord(role, 'warehouse-tasks')) {
        for (const t of db
          .prepare(`SELECT t.task_number AS ref, t.task_type AS note FROM warehouse_tasks t JOIN sales_orders s ON s.id = t.sales_order_id AND s.client_id = t.client_id WHERE t.client_id = ? AND s.so_number = ?`)
          .all(clientId, row.ref) as { ref: string; note: string }[]) related.push(rel('warehouse-tasks', t.ref, t.note));
      }
      if (canAccessRecord(role, 'approvals')) {
        for (const a of db.prepare(`SELECT approval_ref AS ref FROM approvals WHERE client_id = ? AND entity_ref = ?`).all(clientId, row.ref) as { ref: string }[]) related.push(rel('approvals', a.ref));
      }
      return { tables, related };
    },
  },

  invoices: {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'issue_date', label: 'Issued', kind: 'date' },
      { key: 'due_date', label: 'Due', kind: 'date' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'paid_amount', label: 'Received', kind: 'money' },
      { key: 'balance', label: 'Balance', kind: 'money' },
      { key: 'days_overdue', label: 'Days overdue', kind: 'number' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'sales_order', label: 'Sales order' },
    ],
    sql: `SELECT i.invoice_number AS ref, c.name AS customer, i.issue_date, i.due_date, i.amount, i.paid_amount, i.amount - i.paid_amount AS balance,
                 i.status, s.so_number AS sales_order
            FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.client_id = i.client_id
            LEFT JOIN sales_orders s ON s.id = i.sales_order_id AND s.client_id = i.client_id WHERE i.client_id = ?`,
    refExpr: 'i.invoice_number',
    order: 'i.due_date, i.invoice_number',
    post: (r, today) => {
      const open = r.status !== 'paid' && Number(r.balance) > 0.005;
      r.days_overdue = open ? Math.max(0, diffDays(today, String(r.due_date))) : 0;
      if (open && Number(r.days_overdue) > 0) r.status = 'overdue';
    },
    extra: (_db, _c, role, row) => ({ related: row.sales_order && canAccessRecord(role, 'sales-orders') ? [rel('sales-orders', String(row.sales_order))] : [] }),
  },

  products: {
    columns: [
      { key: 'name', label: 'Product' },
      { key: 'category', label: 'Category' },
      { key: 'stock_on_hand', label: 'On hand', kind: 'number' },
      { key: 'reserved_qty', label: 'Reserved', kind: 'number' },
      { key: 'quarantined_qty', label: 'Quarantined', kind: 'number' },
      { key: 'damaged_qty', label: 'Damaged', kind: 'number' },
      { key: 'sellable', label: 'Sellable', kind: 'number' },
      { key: 'reorder_level', label: 'Reorder level', kind: 'number' },
      { key: 'selling_price', label: 'Selling price', kind: 'money' },
      { key: 'unit_cost', label: 'Unit cost', kind: 'money', hideUnless: 'unit_cost' },
    ],
    sql: `SELECT p.sku AS ref, p.name, p.category, p.stock_on_hand, p.reserved_qty, p.quarantined_qty, p.damaged_qty,
                 MAX(0, p.stock_on_hand - p.reserved_qty - p.quarantined_qty - p.damaged_qty) AS sellable, p.reorder_level, p.selling_price, p.unit_cost
            FROM products p WHERE p.client_id = ?`,
    refExpr: 'p.sku',
    order: 'p.sku',
    extra: (db, clientId, role, row) => {
      const tables: Table[] = [];
      const related: Related[] = [];
      tables.push({
        title: 'Recent stock movements',
        columns: [
          { key: 'movement_date', label: 'Date', kind: 'date' },
          { key: 'type', label: 'Type' },
          { key: 'qty', label: 'Qty', kind: 'number' },
          { key: 'reference', label: 'Reference' },
          { key: 'note', label: 'Note' },
        ],
        rows: db
          .prepare(
            `SELECT m.movement_date, m.type, m.qty, m.reference, m.note FROM stock_movements m JOIN products p ON p.id = m.product_id AND p.client_id = m.client_id
              WHERE m.client_id = ? AND p.sku = ? ORDER BY m.movement_date DESC LIMIT 10`,
          )
          .all(clientId, row.ref) as Row[],
      });
      if (canAccessRecord(role, 'purchase-orders')) {
        for (const p of db
          .prepare(
            `SELECT po.po_number AS ref, po.status AS note FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.client_id = pl.client_id
               JOIN products p ON p.id = pl.product_id AND p.client_id = pl.client_id WHERE pl.client_id = ? AND p.sku = ? AND po.status IN ('approved','partially_received','pending_approval')`,
          )
          .all(clientId, row.ref) as { ref: string; note: string }[]) related.push(rel('purchase-orders', p.ref, p.note.replace(/_/g, ' ')));
      }
      return { tables, related };
    },
  },

  'purchase-orders': {
    columns: [
      { key: 'supplier', label: 'Supplier' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'order_date', label: 'Ordered', kind: 'date' },
      { key: 'expected_date', label: 'Expected', kind: 'date' },
      { key: 'days_late', label: 'Days late', kind: 'number' },
      { key: 'total', label: 'Total', kind: 'money', hideUnless: 'supplier_pricing' },
    ],
    sql: `SELECT po.po_number AS ref, s.name AS supplier, po.status, po.order_date, po.expected_date, po.total
            FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id AND s.client_id = po.client_id WHERE po.client_id = ?`,
    refExpr: 'po.po_number',
    order: 'po.expected_date, po.po_number',
    post: (r, today) => {
      const open = ['approved', 'partially_received'].includes(String(r.status));
      r.days_late = open ? Math.max(0, diffDays(today, String(r.expected_date))) : 0;
    },
    extra: (db, clientId, role, row) => ({
      tables: [
        {
          title: 'Purchase order lines',
          columns: [
            { key: 'sku', label: 'SKU' },
            { key: 'product', label: 'Product' },
            { key: 'qty', label: 'Ordered', kind: 'number' },
            { key: 'received_qty', label: 'Received', kind: 'number' },
            ...(canSeeField(role, 'supplier_pricing') ? [{ key: 'unit_price', label: 'Unit price', kind: 'money' as ColumnKind }] : []),
          ],
          rows: db
            .prepare(
              `SELECT p.sku, p.name AS product, pl.qty, pl.received_qty${canSeeField(role, 'supplier_pricing') ? ', pl.unit_price' : ''}
                 FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.client_id = pl.client_id
                 JOIN products p ON p.id = pl.product_id AND p.client_id = pl.client_id WHERE pl.client_id = ? AND po.po_number = ?`,
            )
            .all(clientId, row.ref) as Row[],
        },
      ],
    }),
  },

  'warehouse-tasks': {
    columns: [
      { key: 'task_type', label: 'Type' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'priority', label: 'Priority', kind: 'status' },
      { key: 'due_date', label: 'Due', kind: 'date' },
      { key: 'days_overdue', label: 'Days overdue', kind: 'number' },
      { key: 'assigned_to', label: 'Assigned to' },
      { key: 'sales_order', label: 'Sales order' },
      { key: 'purchase_order', label: 'PO' },
      { key: 'sku', label: 'SKU' },
      { key: 'note', label: 'Note' },
    ],
    sql: `SELECT t.task_number AS ref, t.task_type, t.status, t.priority, t.due_date, t.assigned_to, s.so_number AS sales_order, po.po_number AS purchase_order, p.sku, t.note
            FROM warehouse_tasks t LEFT JOIN sales_orders s ON s.id = t.sales_order_id AND s.client_id = t.client_id
            LEFT JOIN purchase_orders po ON po.id = t.purchase_order_id AND po.client_id = t.client_id
            LEFT JOIN products p ON p.id = t.product_id AND p.client_id = t.client_id WHERE t.client_id = ?`,
    refExpr: 't.task_number',
    order: "CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.due_date, t.task_number",
    post: (r, today) => {
      r.days_overdue = r.status !== 'done' ? Math.max(0, diffDays(today, String(r.due_date))) : 0;
    },
  },

  'marketplace-orders': {
    columns: [
      { key: 'marketplace', label: 'Marketplace' },
      { key: 'marketplace_sku', label: 'Marketplace SKU' },
      { key: 'sku', label: 'Mapped SKU' },
      { key: 'qty', label: 'Qty', kind: 'number' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'order_date', label: 'Order date', kind: 'date' },
      { key: 'return_reason', label: 'Return reason' },
    ],
    sql: `SELECT m.order_ref AS ref, m.marketplace, m.marketplace_sku, p.sku, m.qty, m.amount, m.status, m.order_date, m.return_reason
            FROM marketplace_orders m LEFT JOIN products p ON p.id = m.product_id AND p.client_id = m.client_id WHERE m.client_id = ?`,
    refExpr: 'm.order_ref',
    order: 'm.order_date DESC, m.order_ref',
  },

  settlements: {
    columns: [
      { key: 'marketplace', label: 'Marketplace' },
      { key: 'expected_date', label: 'Expected on', kind: 'date' },
      { key: 'expected_amount', label: 'Expected', kind: 'money' },
      { key: 'received_amount', label: 'Received', kind: 'money' },
      { key: 'difference', label: 'Difference', kind: 'money' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'note', label: 'Note' },
    ],
    sql: `SELECT settlement_ref AS ref, marketplace, expected_date, expected_amount, received_amount, status, note FROM marketplace_settlements ms WHERE ms.client_id = ?`,
    refExpr: 'settlement_ref',
    order: 'expected_date',
    post: (r) => {
      r.difference = r.received_amount === null ? null : Number(r.expected_amount) - Number(r.received_amount);
    },
  },

  approvals: {
    columns: [
      { key: 'entity_type', label: 'Type' },
      { key: 'entity_ref', label: 'Record' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'submitted_by', label: 'Submitted by' },
      { key: 'submitted_at', label: 'Submitted', kind: 'datetime' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'exception_note', label: 'Exception' },
    ],
    sql: `SELECT approval_ref AS ref, entity_type, entity_ref, amount, submitted_by, submitted_at, status, exception_note FROM approvals ap WHERE ap.client_id = ?`,
    refExpr: 'approval_ref',
    order: `CASE status WHEN 'approved' THEN 1 ELSE 0 END, submitted_at`,
    extra: (_db, _c, role, row) => {
      const map: Record<string, RecordType> = { purchase_order: 'purchase-orders', sales_order: 'sales-orders', payment: 'supplier-bills', stock_adjustment: 'products' };
      const t = map[String(row.entity_type)];
      return { related: t && canAccessRecord(role, t) ? [rel(t, String(row.entity_ref))] : [] };
    },
  },

  'supplier-bills': {
    columns: [
      { key: 'supplier', label: 'Supplier' },
      { key: 'purchase_order', label: 'PO' },
      { key: 'due_date', label: 'Due', kind: 'date' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'paid_amount', label: 'Paid', kind: 'money' },
      { key: 'balance', label: 'Balance', kind: 'money' },
      { key: 'days_overdue', label: 'Days overdue', kind: 'number' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    sql: `SELECT b.bill_number AS ref, s.name AS supplier, po.po_number AS purchase_order, b.due_date, b.amount, b.paid_amount, b.amount - b.paid_amount AS balance, b.status
            FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.client_id = b.client_id
            LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id AND po.client_id = b.client_id WHERE b.client_id = ?`,
    refExpr: 'b.bill_number',
    order: 'b.due_date, b.bill_number',
    post: (r, today) => {
      const open = r.status !== 'paid' && Number(r.balance) > 0.005;
      r.days_overdue = open ? Math.max(0, diffDays(today, String(r.due_date))) : 0;
      if (open && Number(r.days_overdue) > 0) r.status = 'overdue';
    },
  },

  'api-events': {
    columns: [
      { key: 'marketplace', label: 'Marketplace' },
      { key: 'event_type', label: 'Event' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'error_message', label: 'Message' },
      { key: 'occurred_at', label: 'When', kind: 'datetime' },
    ],
    sql: `SELECT event_ref AS ref, marketplace, event_type, status, error_message, occurred_at FROM marketplace_api_events ev WHERE ev.client_id = ?`,
    refExpr: 'event_ref',
    order: 'occurred_at DESC',
  },
};

function visibleColumns(def: Def, role: Role): Column[] {
  return def.columns.filter((c) => !c.hideUnless || canSeeField(role, c.hideUnless));
}

function project(row: Row, cols: Column[]): Row {
  const out: Row = { ref: row.ref };
  for (const c of cols) out[c.key] = row[c.key] ?? null;
  return out;
}

export function isRecordType(x: string): x is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(x);
}

function assertAccess(role: Role, type: string): RecordType {
  if (!isRecordType(type)) throw new AppError('NOT_FOUND', 404, 'Unknown record type.');
  if (!canAccessRecord(role, type)) throw new AppError('FORBIDDEN', 403, 'Your role cannot open this kind of record.');
  return type;
}

export function recordTypesFor(role: Role) {
  return RECORD_TYPES.filter((t) => canAccessRecord(role, t)).map((t) => ({ type: t, label: RECORD_META[t].workflowLabel, singular: RECORD_META[t].label }));
}

export function listRecords(db: Db, clientId: number, role: Role, typeRaw: string, now: Date) {
  const type = assertAccess(role, typeRaw);
  const def = DEFS[type];
  const today = istDate(now);
  const cols = visibleColumns(def, role);
  const rows = (db.prepare(`${def.sql} ORDER BY ${def.order} LIMIT 500`).all(clientId) as Row[]).map((r) => {
    def.post?.(r, today);
    return project(r, cols);
  });
  return { type, label: RECORD_META[type].workflowLabel, singular: RECORD_META[type].label, columns: cols, rows };
}

export function getRecord(db: Db, clientId: number, role: Role, typeRaw: string, ref: string, now: Date) {
  const type = assertAccess(role, typeRaw);
  const def = DEFS[type];
  const today = istDate(now);
  const row = db.prepare(`${def.sql} AND ${def.refExpr} = ?`).get(clientId, ref) as Row | undefined;
  if (!row) throw new AppError('NOT_FOUND', 404, `${RECORD_META[type].label} ${ref} was not found.`);
  def.post?.(row, today);
  const cols = visibleColumns(def, role);
  const extra = def.extra?.(db, clientId, role, row, today) ?? {};
  return {
    type,
    label: RECORD_META[type].workflowLabel,
    singular: RECORD_META[type].label,
    ref: String(row.ref),
    columns: cols,
    record: project(row, cols),
    tables: extra.tables ?? [],
    related: extra.related ?? [],
    readOnlyNotice:
      'This is a read-only view. Approvals, payments, stock changes and other actions are performed in the existing WhizUnik workflow and approval process — never by the AI assistant.',
  };
}
