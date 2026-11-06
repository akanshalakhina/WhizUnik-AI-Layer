import bcrypt from 'bcryptjs';
import { addDays, istDate } from '../utils/dates';
import type { Db, Role } from '../types';
import { ROLES } from '../types';

/**
 * Demo / test data. Two clients are seeded on purpose and several record
 * numbers (SO-1021, INV-5001, PO-3001, WT-9001, MP-AMZ-7001, SKU-1001...)
 * exist for BOTH of them with different content, so cross-client leakage is
 * easy to detect in tests and demos.
 *
 * All dates are relative to `now`, so the demo always has "overdue" and
 * "due today" records no matter when it is started.
 */
export interface SeedOptions {
  now?: Date;
  password?: string;
  bcryptRounds?: number;
  /** Limits applied to the demo clients (defaults match .env.example). */
  aiDefaults?: { monthlyCostLimitInr: number; monthlyRequestLimit: number; dailyUserLimit: number };
}

export interface SeedResult {
  clients: { id: number; name: string; emailDomain: string }[];
  today: string;
}

function insert(db: Db, table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(db.prepare(sql).run(...Object.values(row)).lastInsertRowid);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_NAMES: Record<string, Record<Role, string>> = {
  aarav: {
    management: 'Meera Kapoor',
    sales: 'Rohan Mehta',
    procurement: 'Isha Nair',
    warehouse: 'Karan Singh',
    finance: 'Neha Gupta',
    checker: 'Vikram Rao',
  },
  bharat: {
    management: 'Anil Deshmukh',
    sales: 'Pooja Iyer',
    procurement: 'Sameer Khan',
    warehouse: 'Rekha Pillai',
    finance: 'Tarun Bose',
    checker: 'Divya Menon',
  },
};

type ProductSpec = [
  sku: string,
  name: string,
  category: string,
  onHand: number,
  reorder: number,
  cost: number,
  price: number,
  ratePerDay: number,
  quarantined?: number,
  damaged?: number,
];

interface OrderSpec {
  so: string;
  customer: string;
  status: string;
  orderDay: number;
  promisedDay: number;
  lines: [sku: string, qty: number][];
  discount?: number;
  blocked?: string;
  note?: string;
}

class ClientSeeder {
  customers = new Map<string, number>();
  suppliers = new Map<string, number>();
  products = new Map<string, { id: number; price: number; cost: number }>();
  orders = new Map<string, number>();
  pos = new Map<string, number>();
  invoices = new Map<string, number>();

  constructor(
    private db: Db,
    private clientId: number,
    private today: string,
    private seed: number,
  ) {}

  private d(offset: number): string {
    return addDays(this.today, offset);
  }

  customer(name: string, limit: number, terms: number, email: string, phone: string) {
    this.customers.set(
      name,
      insert(this.db, 'customers', {
        client_id: this.clientId,
        name,
        credit_limit: limit,
        payment_terms_days: terms,
        contact_email: email,
        contact_phone: phone,
      }),
    );
  }

  supplier(name: string, lead: number, email: string, bank: string) {
    this.suppliers.set(
      name,
      insert(this.db, 'suppliers', {
        client_id: this.clientId,
        name,
        lead_time_days: lead,
        contact_email: email,
        bank_account: bank,
      }),
    );
  }

  product(spec: ProductSpec) {
    const [sku, name, category, onHand, reorder, cost, price, rate, quarantined = 0, damaged = 0] = spec;
    const id = insert(this.db, 'products', {
      client_id: this.clientId,
      sku,
      name,
      category,
      stock_on_hand: onHand,
      reserved_qty: 0,
      quarantined_qty: quarantined,
      damaged_qty: damaged,
      reorder_level: reorder,
      unit_cost: cost,
      selling_price: price,
    });
    this.products.set(sku, { id, price, cost });

    // 60 days of sales history driving fast / slow-moving analysis.
    const rand = rng(this.seed + id * 31);
    for (let back = 1; back <= 60 && rate > 0; back++) {
      const qty = Math.max(0, Math.round(rate + (rand() - 0.5) * rate * 1.4));
      if (qty > 0 && (rate >= 1 || rand() < rate * 1.5)) {
        insert(this.db, 'sales_history', {
          client_id: this.clientId,
          product_id: id,
          sale_date: this.d(-back),
          qty,
        });
      }
    }
    if (rate === 0) {
      // One old sale, outside the 60-day window: classic dead stock.
      insert(this.db, 'sales_history', { client_id: this.clientId, product_id: id, sale_date: this.d(-100), qty: 2 });
    }
  }

  movement(sku: string, day: number, type: string, qty: number, reference: string, note: string) {
    insert(this.db, 'stock_movements', {
      client_id: this.clientId,
      product_id: this.products.get(sku)!.id,
      movement_date: this.d(day),
      type,
      qty,
      reference,
      note,
    });
  }

  cycleCount(sku: string, day: number, system: number, counted: number) {
    insert(this.db, 'cycle_counts', {
      client_id: this.clientId,
      product_id: this.products.get(sku)!.id,
      count_date: this.d(day),
      system_qty: system,
      counted_qty: counted,
      status: 'open',
    });
  }

  order(o: OrderSpec) {
    const disc = o.discount ?? 0;
    let total = 0;
    const lines = o.lines.map(([sku, qty]) => {
      const p = this.products.get(sku)!;
      const unit = Math.round(p.price * (1 - disc / 100));
      total += unit * qty;
      return { sku, qty, unit, id: p.id };
    });
    const id = insert(this.db, 'sales_orders', {
      client_id: this.clientId,
      so_number: o.so,
      customer_id: this.customers.get(o.customer)!,
      status: o.status,
      order_date: this.d(o.orderDay),
      promised_date: this.d(o.promisedDay),
      total,
      discount_pct: disc,
      blocked_reason: o.blocked ?? null,
      waiting_note: o.note ?? null,
    });
    this.orders.set(o.so, id);
    for (const l of lines) {
      insert(this.db, 'sales_order_lines', {
        client_id: this.clientId,
        sales_order_id: id,
        product_id: l.id,
        qty: l.qty,
        unit_price: l.unit,
      });
    }
  }

  /** reserved_qty = quantity committed on orders that are open but not yet dispatched (and not waiting for stock). */
  recomputeReserved() {
    this.db
      .prepare(
        `UPDATE products SET reserved_qty = COALESCE((
           SELECT SUM(l.qty) FROM sales_order_lines l
           JOIN sales_orders s ON s.id = l.sales_order_id
           WHERE l.product_id = products.id AND s.client_id = products.client_id
             AND s.status IN ('open','waiting_dispatch','waiting_customer_approval','waiting_checker_approval','blocked')
         ), 0) WHERE client_id = ?`,
      )
      .run(this.clientId);
  }

  invoice(num: string, customer: string, so: string | null, issueDay: number, dueDay: number, amount: number, paid = 0) {
    const status = paid >= amount ? 'paid' : paid > 0 ? 'partially_paid' : 'open';
    this.invoices.set(
      num,
      insert(this.db, 'invoices', {
        client_id: this.clientId,
        invoice_number: num,
        customer_id: this.customers.get(customer)!,
        sales_order_id: so ? this.orders.get(so)! : null,
        issue_date: this.d(issueDay),
        due_date: this.d(dueDay),
        amount,
        paid_amount: paid,
        status,
      }),
    );
  }

  purchaseOrder(
    po: string,
    supplier: string,
    status: string,
    orderDay: number,
    expectedDay: number,
    receivedDay: number | null,
    lines: [sku: string, qty: number, received: number, price: number][],
  ) {
    const total = lines.reduce((s, [, q, , p]) => s + q * p, 0);
    const id = insert(this.db, 'purchase_orders', {
      client_id: this.clientId,
      po_number: po,
      supplier_id: this.suppliers.get(supplier)!,
      status,
      order_date: this.d(orderDay),
      expected_date: this.d(expectedDay),
      received_date: receivedDay === null ? null : this.d(receivedDay),
      total,
    });
    this.pos.set(po, id);
    for (const [sku, qty, received, price] of lines) {
      insert(this.db, 'purchase_order_lines', {
        client_id: this.clientId,
        purchase_order_id: id,
        product_id: this.products.get(sku)!.id,
        qty,
        received_qty: received,
        unit_price: price,
      });
    }
  }

  price(supplier: string, sku: string, day: number, unitPrice: number) {
    insert(this.db, 'supplier_prices', {
      client_id: this.clientId,
      supplier_id: this.suppliers.get(supplier)!,
      product_id: this.products.get(sku)!.id,
      price_date: this.d(day),
      unit_price: unitPrice,
    });
  }

  bill(num: string, supplier: string, po: string | null, dueDay: number, amount: number, paid = 0) {
    insert(this.db, 'supplier_bills', {
      client_id: this.clientId,
      bill_number: num,
      supplier_id: this.suppliers.get(supplier)!,
      purchase_order_id: po ? this.pos.get(po)! : null,
      due_date: this.d(dueDay),
      amount,
      paid_amount: paid,
      status: paid >= amount ? 'paid' : 'open',
    });
  }

  task(
    num: string,
    type: string,
    status: string,
    priority: string,
    dueDay: number,
    assignee: string,
    opts: { so?: string; po?: string; sku?: string; note?: string } = {},
  ) {
    insert(this.db, 'warehouse_tasks', {
      client_id: this.clientId,
      task_number: num,
      task_type: type,
      status,
      priority,
      sales_order_id: opts.so ? this.orders.get(opts.so)! : null,
      purchase_order_id: opts.po ? this.pos.get(opts.po)! : null,
      product_id: opts.sku ? this.products.get(opts.sku)!.id : null,
      due_date: this.d(dueDay),
      assigned_to: assignee,
      note: opts.note ?? null,
    });
  }

  mpOrder(
    ref: string,
    marketplace: string,
    mpSku: string,
    sku: string | null,
    qty: number,
    amount: number,
    status: string,
    day: number,
    returnReason: string | null = null,
  ) {
    insert(this.db, 'marketplace_orders', {
      client_id: this.clientId,
      order_ref: ref,
      marketplace,
      marketplace_sku: mpSku,
      product_id: sku ? this.products.get(sku)!.id : null,
      qty,
      amount,
      status,
      order_date: this.d(day),
      invoice_id: null,
      return_reason: returnReason,
    });
  }

  settlement(
    ref: string,
    marketplace: string,
    periodStartDay: number,
    periodEndDay: number,
    expectedDay: number,
    expected: number,
    received: number | null,
    status: string,
    note: string | null = null,
  ) {
    insert(this.db, 'marketplace_settlements', {
      client_id: this.clientId,
      settlement_ref: ref,
      marketplace,
      period_start: this.d(periodStartDay),
      period_end: this.d(periodEndDay),
      expected_date: this.d(expectedDay),
      expected_amount: expected,
      received_amount: received,
      status,
      note,
    });
  }

  apiEvent(ref: string, marketplace: string, type: string, status: string, error: string | null, hoursAgo: number, now: Date) {
    insert(this.db, 'marketplace_api_events', {
      client_id: this.clientId,
      event_ref: ref,
      marketplace,
      event_type: type,
      status,
      error_message: error,
      occurred_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
    });
  }

  approval(
    ref: string,
    entityType: string,
    entityRef: string,
    amount: number | null,
    by: string,
    hoursAgo: number,
    status: string,
    note: string | null,
    now: Date,
  ) {
    insert(this.db, 'approvals', {
      client_id: this.clientId,
      approval_ref: ref,
      entity_type: entityType,
      entity_ref: entityRef,
      amount,
      submitted_by: by,
      submitted_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
      status,
      exception_note: note,
    });
  }
}

export function seedDemoData(db: Db, opts: SeedOptions = {}): SeedResult {
  const now = opts.now ?? new Date();
  const today = istDate(now);
  const password = opts.password ?? 'Demo@12345';
  const hash = bcrypt.hashSync(password, opts.bcryptRounds ?? 10);

  const run = db.transaction(() => {
    // ------------------------------------------------------------ client 1
    // New clients start with AI OFF (PDF Task 15: the feature flag is switched on per client after checks).
    // The two demo clients are switched on here so the demo works; limits come from the configured defaults.
    const lim = opts.aiDefaults ?? { monthlyCostLimitInr: 2000, monthlyRequestLimit: 1500, dailyUserLimit: 40 };
    const aiOn = {
      ai_enabled: 1,
      ai_permitted_roles: JSON.stringify(ROLES),
      ai_monthly_cost_limit_inr: lim.monthlyCostLimitInr,
      ai_monthly_request_limit: lim.monthlyRequestLimit,
      ai_daily_user_limit: lim.dailyUserLimit,
    };
    const c1 = insert(db, 'clients', { name: 'Aarav Consumer Goods Pvt Ltd', plan: 'standard', cash_balance: 850_000, ...aiOn });
    const c2 = insert(db, 'clients', { name: 'Bharat Home Essentials LLP', plan: 'standard', cash_balance: 320_000, ...aiOn });

    for (const [clientId, key] of [
      [c1, 'aarav'],
      [c2, 'bharat'],
    ] as const) {
      for (const role of ROLES) {
        insert(db, 'users', {
          client_id: clientId,
          name: USER_NAMES[key][role],
          email: `${role}@${key}.demo`,
          password_hash: hash,
          role,
        });
      }
    }

    const a = new ClientSeeder(db, c1, today, 1001);

    a.customer('Sunrise Retail Mart', 1_500_000, 30, 'accounts@sunrise-retail.example', '+91-90000-10001');
    a.customer('Metro Lifestyle Stores', 2_500_000, 45, 'ap@metro-lifestyle.example', '+91-90000-10002');
    a.customer('Greenleaf Organics', 500_000, 30, 'finance@greenleaf.example', '+91-90000-10003');
    a.customer('Urban Nest Interiors', 800_000, 30, 'buyer@urbannest.example', '+91-90000-10004');
    a.customer('Kaveri Distributors', 1_200_000, 30, 'orders@kaveri-dist.example', '+91-90000-10005');
    a.customer('Orbit Electronics Hub', 300_000, 30, 'pay@orbit-hub.example', '+91-90000-10006');

    a.supplier('Shree Steelware Industries', 14, 'sales@shree-steel.example', 'HDFC-50100-0012345');
    a.supplier('Metalware Hub Pvt Ltd', 10, 'quotes@metalware-hub.example', 'ICICI-00233-0044556');
    a.supplier('Textura Mills', 21, 'orders@textura.example', 'SBI-31000-0098765');
    a.supplier('Ceramica Exports', 25, 'export@ceramica.example', 'AXIS-91700-0011223');
    a.supplier('Bamboo Craft Co.', 12, 'hello@bamboocraft.example', 'KOTAK-70123-0033445');
    a.supplier('PackRight Solutions', 7, 'sales@packright.example', 'HDFC-50100-0077889');

    const products: ProductSpec[] = [
      ['SKU-1001', 'Steel Water Bottle 750ml', 'Drinkware', 18, 60, 180, 349, 6.0],
      ['SKU-1002', 'Cotton Bath Towel Large', 'Home Textiles', 650, 80, 285, 899, 3.0],
      ['SKU-1003', 'Bamboo Toothbrush Pack of 4', 'Personal Care', 260, 50, 70, 199, 2.0],
      ['SKU-1004', 'Non-stick Frying Pan 24cm', 'Cookware', 200, 40, 420, 999, 2.5],
      ['SKU-1005', 'Ceramic Coffee Mug Set of 6', 'Drinkware', 150, 40, 310, 799, 1.2],
      ['SKU-1006', 'LED Desk Lamp', 'Electricals', 25, 30, 380, 1299, 1.5],
      ['SKU-1007', 'Organic Cotton Bedsheet Queen', 'Home Textiles', 410, 60, 520, 1599, 0.2],
      ['SKU-1008', 'Yoga Mat 6mm', 'Fitness', 300, 30, 260, 899, 2.2],
      ['SKU-1009', 'Glass Storage Jar Set', 'Kitchen', 0, 40, 140, 449, 1.8],
      ['SKU-1010', 'Bamboo Tooth Brush Pack - 4', 'Personal Care', 12, 20, 70, 199, 0.1],
      ['SKU-1011', 'Stainless Steel Lunch Box', 'Drinkware', 520, 50, 330, 1450, 3.4],
      ['SKU-1012', 'Wall Clock Round 12in', 'Home Decor', 300, 20, 210, 599, 0],
      ['SKU-1013', 'Electric Kettle 1.5L', 'Electricals', 80, 25, 610, 1499, 1.1, 12, 6],
      ['SKU-1014', 'Door Mat Coir', 'Home Decor', 220, 30, 95, 299, 0.9],
    ];
    products.forEach((p) => a.product(p));

    a.movement('SKU-1002', -12, 'receipt', 300, 'PO-3001', 'Goods received');
    a.movement('SKU-1011', -5, 'dispatch', -60, 'SO-1019', 'Dispatched to Kaveri Distributors');
    a.movement('SKU-1004', -3, 'adjustment', -120, 'CC-0042', 'Cycle count variance; adjustment approval pending (APR-2005)');
    a.movement('SKU-1013', -4, 'damage', -6, 'QC-0108', 'Damaged in transit; moved to damaged stock');
    a.movement('SKU-1001', -2, 'dispatch', -24, 'MP-BATCH', 'Marketplace dispatch batch');
    a.movement('SKU-1008', -6, 'dispatch', -30, 'SO-1018', 'Dispatched to Metro Lifestyle Stores');
    a.cycleCount('SKU-1004', -3, 320, 200);
    a.cycleCount('SKU-1008', -2, 305, 300);

    const orders: OrderSpec[] = [
      { so: 'SO-1018', customer: 'Metro Lifestyle Stores', status: 'dispatched', orderDay: -14, promisedDay: -9, lines: [['SKU-1002', 120]], discount: 8 },
      { so: 'SO-1019', customer: 'Kaveri Distributors', status: 'invoiced', orderDay: -20, promisedDay: -12, lines: [['SKU-1011', 60], ['SKU-1014', 100]], discount: 10 },
      { so: 'SO-1020', customer: 'Sunrise Retail Mart', status: 'open', orderDay: -3, promisedDay: 2, lines: [['SKU-1002', 60], ['SKU-1008', 40]], discount: 5 },
      {
        so: 'SO-1021', customer: 'Metro Lifestyle Stores', status: 'waiting_stock', orderDay: -6, promisedDay: -1,
        lines: [['SKU-1001', 150], ['SKU-1009', 60]], discount: 5,
        note: 'Allocation on hold: SKU-1001 and SKU-1009 do not have enough sellable stock.',
      },
      { so: 'SO-1022', customer: 'Greenleaf Organics', status: 'open', orderDay: -2, promisedDay: 4, lines: [['SKU-1003', 80], ['SKU-1014', 50]] },
      { so: 'SO-1023', customer: 'Kaveri Distributors', status: 'waiting_dispatch', orderDay: -4, promisedDay: 0, lines: [['SKU-1011', 120], ['SKU-1004', 40]], discount: 12 },
      { so: 'SO-1024', customer: 'Orbit Electronics Hub', status: 'open', orderDay: -1, promisedDay: 5, lines: [['SKU-1006', 10], ['SKU-1013', 6]] },
      {
        so: 'SO-1025', customer: 'Urban Nest Interiors', status: 'waiting_customer_approval', orderDay: -5, promisedDay: 3,
        lines: [['SKU-1007', 60], ['SKU-1002', 40]], discount: 10,
        note: 'Revised quote sent 4 days ago; awaiting customer sign-off.',
      },
      { so: 'SO-1026', customer: 'Sunrise Retail Mart', status: 'open', orderDay: 0, promisedDay: 6, lines: [['SKU-1005', 40], ['SKU-1014', 40]], discount: 5 },
      { so: 'SO-1027', customer: 'Metro Lifestyle Stores', status: 'open', orderDay: -2, promisedDay: 3, lines: [['SKU-1008', 100], ['SKU-1002', 100]], discount: 10 },
      { so: 'SO-1028', customer: 'Kaveri Distributors', status: 'waiting_dispatch', orderDay: -3, promisedDay: -1, lines: [['SKU-1011', 60], ['SKU-1005', 50]], discount: 8 },
      { so: 'SO-1029', customer: 'Greenleaf Organics', status: 'dispatched', orderDay: -9, promisedDay: -4, lines: [['SKU-1005', 20]] },
      {
        so: 'SO-1030', customer: 'Orbit Electronics Hub', status: 'blocked', orderDay: -2, promisedDay: 2,
        lines: [['SKU-1004', 30], ['SKU-1013', 10]],
        blocked: 'Credit limit exceeded: outstanding ₹3,64,000 against credit limit ₹3,00,000 (INV-5006 and INV-5009 are overdue).',
      },
      { so: 'SO-1031', customer: 'Sunrise Retail Mart', status: 'open', orderDay: -1, promisedDay: 7, lines: [['SKU-1002', 300], ['SKU-1011', 200]] },
      {
        so: 'SO-1032', customer: 'Urban Nest Interiors', status: 'waiting_checker_approval', orderDay: -2, promisedDay: 1,
        lines: [['SKU-1006', 15], ['SKU-1013', 10]], discount: 27.5,
        note: 'Discount of 27.5% exceeds the 15% policy; waiting for Checker approval.',
      },
      { so: 'SO-1033', customer: 'Kaveri Distributors', status: 'open', orderDay: -1, promisedDay: 4, lines: [['SKU-1004', 60], ['SKU-1003', 100], ['SKU-1008', 50]], discount: 18 },
      { so: 'SO-1034', customer: 'Metro Lifestyle Stores', status: 'open', orderDay: -2, promisedDay: 0, lines: [['SKU-1014', 40]] },
    ];
    orders.forEach((o) => a.order(o));
    a.recomputeReserved();

    // Receivables: 5 overdue invoices above ₹1 lakh, 2 below.
    a.invoice('INV-5001', 'Metro Lifestyle Stores', 'SO-1018', -14, 16, 245_000);
    a.invoice('INV-5002', 'Kaveri Distributors', 'SO-1019', -20, 10, 128_000);
    a.invoice('INV-5003', 'Sunrise Retail Mart', null, -60, -30, 185_000);
    a.invoice('INV-5004', 'Metro Lifestyle Stores', null, -50, -20, 312_500, 100_000);
    a.invoice('INV-5005', 'Greenleaf Organics', null, -45, -15, 64_000);
    a.invoice('INV-5006', 'Orbit Electronics Hub', null, -70, -40, 240_000);
    a.invoice('INV-5007', 'Kaveri Distributors', null, -35, -5, 98_500);
    a.invoice('INV-5008', 'Urban Nest Interiors', null, -30, -2, 156_000);
    a.invoice('INV-5009', 'Orbit Electronics Hub', null, -40, -10, 124_000);
    a.invoice('INV-5010', 'Sunrise Retail Mart', null, -5, 25, 96_000);
    a.invoice('INV-5011', 'Metro Lifestyle Stores', null, -25, 5, 175_000);
    a.invoice('INV-5012', 'Greenleaf Organics', null, -50, -20, 82_000, 82_000);

    // Procurement
    a.purchaseOrder('PO-3001', 'Textura Mills', 'received', -30, -15, -12, [['SKU-1002', 300, 300, 262]]);
    a.purchaseOrder('PO-3002', 'Shree Steelware Industries', 'approved', -18, -4, null, [['SKU-1001', 500, 0, 205]]);
    a.purchaseOrder('PO-3003', 'Ceramica Exports', 'approved', -25, -10, null, [['SKU-1009', 300, 0, 140], ['SKU-1005', 100, 0, 310]]);
    a.purchaseOrder('PO-3004', 'Bamboo Craft Co.', 'partially_received', -12, -2, null, [['SKU-1003', 200, 120, 68]]);
    a.purchaseOrder('PO-3005', 'PackRight Solutions', 'approved', -3, 9, null, [['SKU-1014', 300, 0, 92]]);
    a.purchaseOrder('PO-3006', 'Textura Mills', 'pending_approval', -1, 14, null, [['SKU-1002', 300, 0, 285]]);
    a.purchaseOrder('PO-3007', 'Shree Steelware Industries', 'received', -40, -30, -24, [['SKU-1004', 150, 150, 415]]);
    a.purchaseOrder('PO-3008', 'Bamboo Craft Co.', 'received', -60, -45, -45, [['SKU-1003', 300, 300, 66]]);

    a.price('Shree Steelware Industries', 'SKU-1001', -120, 180);
    a.price('Shree Steelware Industries', 'SKU-1001', -60, 182);
    a.price('Shree Steelware Industries', 'SKU-1001', -18, 205);
    a.price('Metalware Hub Pvt Ltd', 'SKU-1001', -10, 189);
    a.price('Textura Mills', 'SKU-1002', -120, 255);
    a.price('Textura Mills', 'SKU-1002', -30, 262);
    a.price('Textura Mills', 'SKU-1002', -1, 285);
    a.price('Ceramica Exports', 'SKU-1009', -90, 138);
    a.price('Ceramica Exports', 'SKU-1009', -25, 140);
    a.price('Shree Steelware Industries', 'SKU-1004', -100, 400);
    a.price('Shree Steelware Industries', 'SKU-1004', -40, 415);
    a.price('Bamboo Craft Co.', 'SKU-1003', -60, 66);
    a.price('Bamboo Craft Co.', 'SKU-1003', -12, 68);

    a.bill('BILL-7001', 'Shree Steelware Industries', 'PO-3007', 7, 62_250);
    a.bill('BILL-7002', 'Textura Mills', 'PO-3001', 12, 78_600);
    a.bill('BILL-7003', 'Bamboo Craft Co.', 'PO-3008', -6, 19_800);
    a.bill('BILL-7004', 'Ceramica Exports', null, 22, 310_000);
    a.bill('BILL-7005', 'PackRight Solutions', null, 40, 75_000);

    // Warehouse
    a.task('WT-9000', 'pick', 'done', 'normal', -1, 'Picker A', { so: 'SO-1023' });
    a.task('WT-9001', 'dispatch', 'pending', 'urgent', -1, 'Dock Team', { so: 'SO-1028', note: 'Courier pickup missed yesterday' });
    a.task('WT-9002', 'dispatch', 'pending', 'high', 0, 'Dock Team', { so: 'SO-1023' });
    a.task('WT-9003', 'pick', 'in_progress', 'normal', 0, 'Picker A', { so: 'SO-1020' });
    a.task('WT-9004', 'pick', 'pending', 'normal', 1, 'Picker A', { so: 'SO-1022' });
    a.task('WT-9005', 'pick', 'pending', 'normal', 1, 'Picker B', { so: 'SO-1026' });
    a.task('WT-9006', 'putaway', 'pending', 'high', -1, 'Inbound Team', { po: 'PO-3004', sku: 'SKU-1003', note: 'Partial receipt of PO-3004 not yet put away' });
    a.task('WT-9007', 'cycle_count', 'pending', 'high', -2, 'Inventory Control', { sku: 'SKU-1004', note: 'Recount after 120-unit variance' });
    a.task('WT-9008', 'pick', 'pending', 'normal', 2, 'Picker B', { so: 'SO-1027' });
    a.task('WT-9009', 'pack', 'pending', 'normal', 3, 'Picker A', { so: 'SO-1024' });
    a.task('WT-9010', 'quality_check', 'pending', 'high', 0, 'QC Team', { sku: 'SKU-1013', note: 'Inspect 12 quarantined kettles' });

    // Marketplace
    a.mpOrder('MP-AMZ-7001', 'Amazon', 'AMZ-JAR-SET', 'SKU-1009', 2, 898, 'waiting_stock', -1);
    a.mpOrder('MP-AMZ-7002', 'Amazon', 'AMZ-JAR-SET', 'SKU-1009', 3, 1347, 'waiting_stock', 0);
    a.mpOrder('MP-AMZ-7003', 'Amazon', 'AMZ-LB-STL', 'SKU-1011', 1, 1450, 'waiting_invoice', -2);
    a.mpOrder('MP-AMZ-7004', 'Amazon', 'AMZ-TWL-L', 'SKU-1002', 2, 1798, 'shipped', -3);
    a.mpOrder('MP-AMZ-7005', 'Amazon', 'AMZ-MUG-6PC-BLUE', null, 1, 799, 'blocked_unmapped', -2);
    a.mpOrder('MP-FK-8001', 'Flipkart', 'FK-MUG-6', 'SKU-1005', 1, 799, 'waiting_invoice', -1);
    a.mpOrder('MP-FK-8002', 'Flipkart', 'FK-BTL-NEW-750', null, 1, 349, 'blocked_unmapped', -1);
    a.mpOrder('MP-FK-8003', 'Flipkart', 'FK-BTL-NEW-750', null, 2, 698, 'blocked_unmapped', 0);
    a.mpOrder('MP-FK-8004', 'Flipkart', 'FK-LB-STL', 'SKU-1011', 1, 1450, 'waiting_invoice', 0);
    for (let i = 1; i <= 8; i++) {
      const returned = i <= 3;
      a.mpOrder(`MP-MY-90${String(i).padStart(2, '0')}`, 'Myntra', 'MY-YOGA-6MM', 'SKU-1008', 1, 899, returned ? 'returned' : 'delivered', -8 - i * 3,
        returned ? 'Mat thinner than described' : null);
    }
    for (let i = 1; i <= 10; i++) {
      const returned = i === 1;
      a.mpOrder(`MP-AMZ-71${String(i).padStart(2, '0')}`, 'Amazon', 'AMZ-BTL-750', 'SKU-1001', 1, 349, returned ? 'returned' : 'delivered', -6 - i * 4,
        returned ? 'Dented on arrival' : null);
    }

    a.settlement('ST-AMZ-2410', 'Amazon', -40, -26, -12, 385_000, 372_200, 'short_paid', 'Received ₹12,800 less than expected; fee breakdown not yet reconciled.');
    a.settlement('ST-FK-2410', 'Flipkart', -25, -11, 3, 214_000, null, 'pending');
    a.settlement('ST-AMZ-2411', 'Amazon', -25, -11, 6, 296_000, null, 'pending');
    a.settlement('ST-MY-2409', 'Myntra', -55, -41, -8, 142_000, null, 'overdue', 'Expected 8 days ago; nothing received yet.');

    a.apiEvent('EVT-4001', 'Amazon', 'order_sync', 'failed', 'HTTP 503 from marketplace API (retry 3 of 5)', 3, now);
    a.apiEvent('EVT-4002', 'Flipkart', 'inventory_push', 'failed', 'Rejected: unknown SKU mapping FK-BTL-NEW-750', 20, now);
    a.apiEvent('EVT-4003', 'Myntra', 'settlement_fetch', 'failed', 'Authorisation expired; reconnect required', 40, now);
    a.apiEvent('EVT-4004', 'Amazon', 'inventory_push', 'ok', null, 2, now);

    a.approval('APR-2001', 'purchase_order', 'PO-3006', 85_500, 'Isha Nair', 20, 'pending', null, now);
    a.approval('APR-2002', 'sales_order', 'SO-1032', null, 'Rohan Mehta', 44, 'exception', 'Discount 27.5% exceeds the 15% policy', now);
    a.approval('APR-2003', 'sales_order', 'SO-1030', null, 'Rohan Mehta', 40, 'exception', 'Customer credit limit exceeded', now);
    a.approval('APR-2004', 'payment', 'BILL-7001', 62_250, 'Neha Gupta', 70, 'pending', null, now);
    a.approval('APR-2005', 'stock_adjustment', 'SKU-1004', null, 'Karan Singh', 72, 'pending', 'Adjustment of -120 units after cycle count variance', now);
    a.approval('APR-1999', 'purchase_order', 'PO-3005', 27_600, 'Isha Nair', 90, 'approved', null, now);

    // ------------------------------------------------------------ client 2
    const b = new ClientSeeder(db, c2, today, 2002);
    b.customer('Lotus Mart', 600_000, 30, 'accounts@lotusmart.example', '+91-90000-20001');
    b.customer('Hari Om Traders', 400_000, 30, 'hariom@traders.example', '+91-90000-20002');
    b.supplier('Copperline Works', 12, 'sales@copperline.example', 'PNB-10010-0055667');
    b.supplier('Fabrica Mills', 18, 'orders@fabrica.example', 'BOB-20020-0066778');

    const products2: ProductSpec[] = [
      ['SKU-1001', 'Copper Bottle 1L', 'Drinkware', 40, 30, 410, 899, 1.5],
      ['SKU-1002', 'Linen Curtain Pair', 'Home Textiles', 15, 20, 650, 1799, 0.8],
      ['SKU-2001', 'Cast Iron Skillet 10in', 'Cookware', 80, 25, 520, 1299, 0.6],
    ];
    products2.forEach((p) => b.product(p));
    b.order({ so: 'SO-1021', customer: 'Lotus Mart', status: 'blocked', orderDay: -4, promisedDay: 1, lines: [['SKU-1002', 10]], blocked: 'Pricing exception awaiting Checker approval.' });
    b.order({ so: 'SO-9001', customer: 'Hari Om Traders', status: 'waiting_stock', orderDay: -3, promisedDay: -1, lines: [['SKU-1002', 30]], note: 'Linen curtains out of stock at Bharat warehouse.' });
    b.order({ so: 'SO-9002', customer: 'Lotus Mart', status: 'open', orderDay: -1, promisedDay: 5, lines: [['SKU-2001', 12]] });
    b.recomputeReserved();
    b.invoice('INV-5001', 'Lotus Mart', null, -75, -45, 90_000);
    b.invoice('INV-6001', 'Hari Om Traders', null, -50, -20, 520_000);
    b.purchaseOrder('PO-3001', 'Fabrica Mills', 'approved', -30, -12, null, [['SKU-1002', 100, 0, 610]]);
    b.bill('BILL-8001', 'Fabrica Mills', 'PO-3001', 9, 61_000);
    b.task('WT-9001', 'pick', 'pending', 'urgent', -1, 'Picker X', { so: 'SO-9001' });
    b.mpOrder('MP-AMZ-7001', 'Amazon', 'AMZ-COPPER-1L', null, 1, 899, 'blocked_unmapped', -1);
    b.settlement('ST-AMZ-2410', 'Amazon', -40, -26, -10, 99_000, 91_000, 'short_paid', 'Short payment under review.');
    b.apiEvent('EVT-4001', 'Amazon', 'order_sync', 'failed', 'HTTP 500 from marketplace API', 5, now);
    b.approval('APR-2001', 'purchase_order', 'PO-3001', 61_000, 'Sameer Khan', 30, 'pending', null, now);
  });

  run();

  return {
    clients: [
      { id: 1, name: 'Aarav Consumer Goods Pvt Ltd', emailDomain: 'aarav.demo' },
      { id: 2, name: 'Bharat Home Essentials LLP', emailDomain: 'bharat.demo' },
    ],
    today,
  };
}
