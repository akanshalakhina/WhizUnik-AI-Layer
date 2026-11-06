import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getCashFlowSummary,
  getDelayedPurchaseOrders,
  getLowStockProducts,
  getMarketplaceExceptions,
  getOpenSalesOrders,
  getOverdueInvoices,
  getPendingApprovals,
  getPendingWarehouseTasks,
  getSalesOrderDetail,
  nameSimilarity,
  normaliseProductName,
} from '../src/services/ai-data-tools.service';
import type { ToolContext, ToolResult } from '../src/services/ai-data-tools.service';
import type { Role } from '../src/types';
import { makeEnv, NOW } from './helpers';
import type { TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(() => env.cleanup());

const ctx = (role: Role, clientId = 1, maxRecords = 25): ToolContext => ({ db: env.roDb, clientId, userId: 1, role, now: NOW, maxRecords });
const refs = (r: ToolResult) => r.sections.flatMap((s) => s.items.map((i) => i.ref));
const section = (r: ToolResult, key: string) => r.sections.find((s) => s.key === key)!;

describe('data tools: client isolation', () => {
  it('returns only the authenticated client’s sales orders', () => {
    const a = refs(getOpenSalesOrders(ctx('management', 1)));
    const b = refs(getOpenSalesOrders(ctx('management', 2)));
    expect(a).toContain('SO-1021');
    expect(a).not.toContain('SO-9001');
    expect(b).toContain('SO-9001');
    expect(b).not.toContain('SO-1028');
  });

  it('same record number resolves to different content per client', () => {
    const a = getSalesOrderDetail(ctx('management', 1), { ref: 'SO-1021' });
    const b = getSalesOrderDetail(ctx('management', 2), { ref: 'SO-1021' });
    expect(a.sections[0].items[0].detail).toContain('waiting for stock');
    expect(a.sections[0].items[0].detail).toContain('Steel Water Bottle');
    expect(b.sections[0].items[0].detail).toContain('Pricing exception');
    expect(b.sections[0].items[0].detail).not.toContain('Steel Water Bottle');
  });

  it('a record that exists only for another client is "not found"', () => {
    const r = getSalesOrderDetail(ctx('management', 1), { ref: 'SO-9001' });
    expect(r.empty).toBe(true);
    expect(r.notFound).toEqual(['SO-9001']);
    expect(JSON.stringify(r)).not.toContain('Hari Om');
  });

  it('every tool only returns data for the requested client', () => {
    const other = ['Lotus Mart', 'Hari Om', 'Copperline', 'Fabrica', 'Copper Bottle', 'Linen Curtain'];
    const tools = [getOpenSalesOrders, getOverdueInvoices, getLowStockProducts, getDelayedPurchaseOrders, getPendingWarehouseTasks, getMarketplaceExceptions, getCashFlowSummary, getPendingApprovals];
    for (const t of tools) {
      const text = JSON.stringify(t(ctx('management', 1), {}));
      for (const name of other) expect(text, `${t.name} leaked ${name}`).not.toContain(name);
    }
  });
});

describe('data tools: empty results and limits', () => {
  it('handles a client with no records', () => {
    env.db.prepare("INSERT INTO clients (id, name) VALUES (99, 'Empty Co')").run();
    const tools = [getOpenSalesOrders, getOverdueInvoices, getLowStockProducts, getDelayedPurchaseOrders, getPendingWarehouseTasks, getMarketplaceExceptions, getCashFlowSummary, getPendingApprovals];
    for (const t of tools) {
      const r = t(ctx('management', 99), {});
      expect(r.headline.length).toBeGreaterThan(5);
      if (t !== getCashFlowSummary) expect(r.empty, t.name).toBe(true);
    }
    // Cash-flow still reports the (zero) position rather than failing.
    expect(getCashFlowSummary(ctx('management', 99)).figures.length).toBeGreaterThan(3);
  });

  it('caps the number of records and reports the true total', () => {
    const r = getOverdueInvoices(ctx('management', 1, 2));
    const s = section(r, 'invoices');
    expect(s.shown).toBe(2);
    expect(s.items).toHaveLength(2);
    expect(s.total).toBe(7);
  });
});

describe('data tools: only required fields, no sensitive data', () => {
  it('never exposes contact details, bank details or credentials', () => {
    const tools = [getOpenSalesOrders, getOverdueInvoices, getLowStockProducts, getDelayedPurchaseOrders, getPendingWarehouseTasks, getMarketplaceExceptions, getCashFlowSummary, getPendingApprovals];
    const text = tools.map((t) => JSON.stringify(t(ctx('management', 1), {}))).join('\n') + JSON.stringify(getSalesOrderDetail(ctx('management'), { ref: 'SO-1030' }));
    expect(text).not.toMatch(/@[a-z-]+\.example/i); // customer / supplier e-mail addresses
    expect(text).not.toMatch(/\+91-9\d{4}-\d{5}/); // phone numbers
    expect(text).not.toMatch(/(HDFC|ICICI|SBI|AXIS|KOTAK)-\d/); // bank accounts
    expect(text).not.toMatch(/password|\$2[aby]\$|token|api[_-]?key/i);
  });
});

describe('data tools: role restrictions', () => {
  it('rejects a tool the role may not use', () => {
    expect(() => getCashFlowSummary(ctx('sales'))).toThrow(/not permitted/);
    expect(() => getDelayedPurchaseOrders(ctx('warehouse'))).toThrow(/not permitted/);
    expect(() => getOpenSalesOrders(ctx('procurement'))).toThrow(/not permitted/);
    expect(() => getPendingApprovals(ctx('sales'))).toThrow(/not permitted/);
    // PDF section 8: Checker = pending approvals and exceptions only; Sales has no marketplace-operations role.
    expect(() => getOpenSalesOrders(ctx('checker'))).toThrow(/not permitted/);
    expect(() => getSalesOrderDetail(ctx('checker'), { ref: 'SO-1030' })).toThrow(/not permitted/);
    expect(() => getMarketplaceExceptions(ctx('sales'))).toThrow(/not permitted/);
    expect(() => getMarketplaceExceptions(ctx('checker'))).toThrow(/not permitted/);
    expect(() => getMarketplaceExceptions(ctx('warehouse'))).toThrow(/not permitted/);
  });

  it('strips cost data for roles that may not see it', () => {
    const wh = JSON.stringify(getLowStockProducts(ctx('warehouse')));
    expect(wh).not.toContain('estimatedCost');
    expect(wh).not.toContain('stockValueAtCost');
    expect(wh).not.toMatch(/PO-30\d\d/); // purchase order numbers are not for warehouse
    expect(getLowStockProducts(ctx('warehouse')).hiddenForRole.length).toBeGreaterThan(0);
    const mgmt = JSON.stringify(getLowStockProducts(ctx('management')));
    expect(mgmt).toContain('estimatedCost');
  });

  it('marketplace tool: Finance gets only invoice and settlement parts, Management gets everything', () => {
    const fin = getMarketplaceExceptions(ctx('finance'));
    expect(fin.sections.map((s) => s.key)).toEqual(['waitingForInvoice', 'settlementDifferences']);
    const finText = JSON.stringify(fin.sections) + JSON.stringify(fin.figures) + fin.headline;
    expect(finText).toContain('12,800'); // settlement difference
    expect(finText).not.toMatch(/FK-BTL-NEW|EVT-400|SKU-1008|unmapped/i); // mapping / API / return data is outside Finance
    expect(fin.hiddenForRole.join()).toContain('outside Finance access');
    const mgmt = getMarketplaceExceptions(ctx('management'));
    expect(mgmt.sections.map((s) => s.key)).toEqual(['unmappedSkus', 'waitingForStock', 'waitingForInvoice', 'apiFailures', 'returnRisk', 'settlementDifferences']);
  });

  it('removes personal data from free text before it can reach the model', () => {
    env.db.prepare("UPDATE sales_orders SET waiting_note = 'Call buyer a.b@corp.com on +91 98765 43210, PAN ABCDE1234F, about stock' WHERE so_number = 'SO-1021' AND client_id = 1").run();
    const text = JSON.stringify(getOpenSalesOrders(ctx('management'))) + JSON.stringify(getSalesOrderDetail(ctx('management'), { ref: 'SO-1021' }));
    expect(text).not.toMatch(/a\.b@corp\.com|98765|ABCDE1234F/);
    expect(text).toContain('[EMAIL]');
    env.db.prepare("UPDATE sales_orders SET waiting_note = 'Allocation on hold: SKU-1001 and SKU-1009 do not have enough sellable stock.' WHERE so_number = 'SO-1021' AND client_id = 1").run();
  });

  it('does not send the name of the person who submitted an approval', () => {
    const text = JSON.stringify(getPendingApprovals(ctx('checker')));
    expect(text).not.toMatch(/Isha Nair|Rohan Mehta|Neha Gupta|Karan Singh|submitted_by|submitted by/);
  });

  it('"above" and "below" amounts are strict comparisons', () => {
    const exact = env.db.prepare("SELECT total FROM sales_orders WHERE so_number = 'SO-1034' AND client_id = 1").get() as { total: number };
    const r = getOpenSalesOrders(ctx('management'), { minAmount: exact.total });
    expect(r.sections[0].items.map((i) => i.ref)).not.toContain('SO-1034');
  });

  it('hides supplier pricing from non-purchasing roles', () => {
    const r = getSalesOrderDetail(ctx('sales'), { ref: 'SO-1021' });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/PO-300\d/); // sales cannot open purchase orders: only "inbound supply" wording
    expect(r.sections[0].items[0].detail).toContain('Inbound supply');
    const p = getDelayedPurchaseOrders(ctx('management'));
    expect(JSON.stringify(p)).toContain('priceIncreases');
  });
});

describe('data tools: business logic', () => {
  it('finds overdue invoices above ₹1 lakh using the outstanding balance', () => {
    const r = getOverdueInvoices(ctx('finance'), { minAmount: 100_000 });
    expect(refs(r).filter((x) => x.startsWith('INV'))).toEqual(expect.arrayContaining(['INV-5003', 'INV-5004', 'INV-5006', 'INV-5008', 'INV-5009']));
    expect(section(r, 'invoices').total).toBe(5);
    expect(refs(r)).not.toContain('INV-5005'); // ₹64,000
    expect(r.assumptions.join(' ')).toContain('outstanding balances');
  });

  it('explains why SO-1021 is waiting, with supply and delay facts', () => {
    const d = getSalesOrderDetail(ctx('management'), { ref: 'so-1021' }).sections[0].items[0].detail;
    expect(d).toContain('short by 132');
    expect(d).toContain('PO-3002');
    expect(d).toContain('4 days late');
    expect(d).toContain('PO-3003');
  });

  it('explains why SO-1030 is blocked using the customer’s overdue invoices', () => {
    const r = getSalesOrderDetail(ctx('sales'), { ref: 'SO-1030' });
    expect(r.sections[0].items[0].detail).toContain('Credit limit exceeded');
    expect(refs(r)).toEqual(expect.arrayContaining(['INV-5006', 'INV-5009']));
  });

  it('detects stock-out risk, slow movers, fast movers, duplicates and unusual movements', () => {
    const r = getLowStockProducts(ctx('management'), { horizonDays: 30 });
    expect(refs({ ...r, sections: [section(r, 'stockOutRisk')] })).toEqual(expect.arrayContaining(['SKU-1001', 'SKU-1009', 'SKU-1006']));
    expect(section(r, 'slowMoving').items.map((i) => i.ref)).toEqual(expect.arrayContaining(['SKU-1007', 'SKU-1012']));
    expect(section(r, 'fastMoving').items.map((i) => i.ref)).toContain('SKU-1001');
    expect(section(r, 'duplicates').items[0].detail).toMatch(/SKU-1003.*SKU-1010|SKU-1010.*SKU-1003/);
    expect(section(r, 'unusualMovements').items.map((i) => i.ref)).toContain('SKU-1004');
    // SKU-1006 has no stock and nothing on order -> reorder; SKU-1001 already has 500 units on order -> no reorder.
    const reorder = section(r, 'reorder').items;
    const lamp = reorder.find((i) => i.ref === 'SKU-1006')!;
    expect(Number(lamp.data.suggestedOrderQty)).toBeGreaterThan(0);
    expect(reorder.map((i) => i.ref)).not.toContain('SKU-1001');
  });

  it('normalises product names for duplicate detection', () => {
    expect(normaliseProductName('Bamboo Tooth Brush Pack - 4')).toBe(normaliseProductName('Bamboo Toothbrush Pack of 4'));
    expect(nameSimilarity('Steel Water Bottle 750ml', 'Door Mat Coir')).toBeLessThan(0.3);
  });

  it('flags delayed purchase orders, supplier performance, price rises and cheaper alternatives', () => {
    const r = getDelayedPurchaseOrders(ctx('procurement'));
    expect(section(r, 'delayedPos').items.map((i) => i.ref).sort()).toEqual(['PO-3002', 'PO-3003', 'PO-3004']);
    const rise = section(r, 'priceIncreases').items.find((i) => i.title.startsWith('SKU-1001'))!;
    expect(rise.detail).toContain('Metalware Hub');
    expect(Number(rise.data.increasePct)).toBeGreaterThan(12);
    expect(section(r, 'supplierPerformance').items.some((i) => i.detail.includes('Shree Steelware'))).toBe(true);
  });

  it('summarises warehouse workload, deadlines, discrepancies and quarantined stock', () => {
    const r = getPendingWarehouseTasks(ctx('warehouse'));
    expect(section(r, 'dispatchDeadlines').items.map((i) => i.ref)).toEqual(expect.arrayContaining(['WT-9001', 'WT-9002']));
    expect(section(r, 'discrepancies').items.map((i) => i.ref)).toContain('SKU-1004');
    expect(section(r, 'quarantined').items.map((i) => i.ref)).toContain('SKU-1013');
    expect(r.figures.some((f) => f.label.startsWith('Workload'))).toBe(true);
  });

  it('classifies marketplace exceptions', () => {
    const r = getMarketplaceExceptions(ctx('management'));
    expect(section(r, 'unmappedSkus').total).toBe(2); // two distinct unmapped marketplace SKUs
    expect(section(r, 'waitingForStock').total).toBe(2);
    expect(section(r, 'waitingForInvoice').total).toBe(3);
    expect(section(r, 'apiFailures').total).toBe(3);
    expect(section(r, 'returnRisk').items.map((i) => i.ref)).toContain('SKU-1008');
    expect(section(r, 'settlementDifferences').total).toBe(2);
  });

  it('computes expected cash flow with disclosed assumptions', () => {
    const r = getCashFlowSummary(ctx('finance'));
    const fig = Object.fromEntries(r.figures.map((f) => [f.label, f.value]));
    expect(fig['Total expected inflows']).toBe('₹11,54,000');
    expect(fig['Supplier payments due (incl. overdue)']).toBe('₹4,70,650');
    expect(fig['Projected closing balance']).toBe('₹15,33,350');
    expect(r.period).toMatchObject({ from: '2026-11-05', to: '2026-11-30' });
    expect(r.assumptions.length).toBeGreaterThanOrEqual(3);
  });

  it('lists pending approvals with ageing', () => {
    const r = getPendingApprovals(ctx('checker'));
    expect(section(r, 'approvals').total).toBe(5);
    expect(section(r, 'approvals').items.some((i) => i.flags.includes('aged'))).toBe(true);
  });
});

describe('data tools: read-only database handle', () => {
  it('cannot modify platform records through the handle given to tools', () => {
    expect(() => env.roDb.prepare('UPDATE products SET stock_on_hand = 0').run()).toThrow();
    expect(() => env.roDb.prepare("DELETE FROM invoices WHERE client_id = 1").run()).toThrow();
    expect(() => env.roDb.prepare("INSERT INTO ai_usage (client_id,user_id,request_id,question,created_at,usage_date,model,provider,status) VALUES (1,1,'x','q','t','d','m','p','s')").run()).toThrow();
  });
});
