import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyQuestion, extractPeriod, isComplexQuestion, selectTools } from '../src/services/ai-classifier.service';
import { CATEGORY_TOOLS, FIELD_PERMISSIONS, ToolGate, TOOL_PERMISSIONS, canAccessRecord, canUseTool, permissionMatrix } from '../src/services/ai-permissions.service';
import { CATEGORIES, ROLES, TOOL_NAMES } from '../src/types';
import type { Category, Role } from '../src/types';
import { ask, makeEnv } from './helpers';
import type { TestEnv } from './helpers';

const TODAY = '2026-11-05';
const cls = (q: string) => classifyQuestion(q, TODAY, { suppliers: ['Textura Mills', 'Shree Steelware Industries'], customers: ['Kaveri Distributors'] });

describe('question classification (Task 5)', () => {
  const cases: [string, Category][] = [
    ['Which sales orders need attention today?', 'sales'],
    ['Which orders need attention today?', 'sales'],
    ['Why is SO-1021 blocked?', 'sales'],
    ['Why is SO-1021 waiting?', 'sales'],
    ['Which invoices are overdue?', 'finance'],
    ['Which invoices above ₹1 lakh are overdue?', 'finance'],
    ['What is expected cash flow this month?', 'finance'],
    ['What stock will run out soon?', 'inventory'],
    ['What stock may run out this month?', 'inventory'],
    ['Which suppliers have delayed POs?', 'procurement'],
    ['Which Purchase Orders are delayed?', 'procurement'],
    ['Which marketplace orders are blocked?', 'marketplace'],
    ['Which marketplace orders are waiting for an invoice?', 'marketplace'],
    ['What are the dispatch deadlines today?', 'warehouse'],
    ['What should we pick first?', 'warehouse'],
    ['What needs attention today?', 'management'],
    ['Give me the daily business summary', 'management'],
    ['Which orders are waiting for dispatch?', 'sales'],
    ['Show unmapped SKUs on Flipkart', 'marketplace'],
    ['Are there duplicate products?', 'inventory'],
  ];
  it.each(cases)('%s -> %s', (q, expected) => {
    expect(cls(q).category).toBe(expected);
  });

  it('treats unrelated questions as unknown', () => {
    for (const q of ['What is the weather like?', 'Tell me a joke', 'hello', 'asdf qwer']) expect(cls(q).category).toBe('unknown');
  });

  it('only ever returns a known category', () => {
    for (const q of ['x', 'orders', 'stock', '???', 'invoice marketplace warehouse']) expect(CATEGORIES).toContain(cls(q).category);
  });

  it('extracts amounts, periods, marketplaces and known names', () => {
    expect(cls('Which invoices above ₹1 lakh are overdue?').params.minAmount).toBe(100_000);
    expect(cls('invoices over 2.5 lakh overdue').params.minAmount).toBe(250_000);
    expect(cls('invoices above Rs 50,000').params.minAmount).toBe(50_000);
    expect(cls('invoices below 10k overdue').params.maxAmount).toBe(10_000);
    expect(cls('show flipkart orders waiting').params.marketplace).toBe('Flipkart');
    expect(cls('Which POs from Textura are delayed?').params.supplier).toBe('Textura Mills');
    expect(cls('overdue invoices for Kaveri').params.customer).toBe('Kaveri Distributors');
    expect(cls('Why is so-1021 blocked').refs).toEqual([{ prefix: 'SO', ref: 'SO-1021' }]);
  });

  it('extracts date ranges', () => {
    expect(extractPeriod('expected cash flow this month', TODAY)).toMatchObject({ from: '2026-11-05', to: '2026-11-30' });
    expect(extractPeriod('orders due tomorrow', TODAY)).toMatchObject({ from: '2026-11-06', to: '2026-11-06' });
    expect(extractPeriod('stock needs in the next 10 days', TODAY)).toMatchObject({ to: '2026-11-15' });
    expect(extractPeriod('payments next month', TODAY)).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
    expect(extractPeriod('what is overdue', TODAY)).toBeNull();
  });
});

describe('tool-selection rules and the category gate', () => {
  it('selects the approved tools for each category', () => {
    expect(selectTools(cls('Which sales orders need attention today?'), 'management', TODAY).calls.map((c) => c.tool)).toEqual(['getOpenSalesOrders']);
    expect(selectTools(cls('Why is SO-1021 blocked?'), 'management', TODAY).calls.map((c) => c.tool)).toEqual(['getSalesOrderDetail']);
    expect(selectTools(cls('Why is SO-1021 blocked?'), 'sales', TODAY).calls[0].params.ref).toBe('SO-1021');
    expect(selectTools(cls('What is expected cash flow this month?'), 'finance', TODAY).calls.map((c) => c.tool)).toEqual(['getCashFlowSummary']);
    expect(selectTools(cls('Which invoices are overdue?'), 'finance', TODAY).calls.map((c) => c.tool)).toEqual(['getOverdueInvoices']);
    expect(selectTools(cls('What stock will run out soon?'), 'management', TODAY).calls[0].params).toMatchObject({ focus: 'stockout', horizonDays: 14 });
    expect(selectTools(cls('What stock may run out this month?'), 'management', TODAY).calls[0].params.horizonDays).toBe(25);
    expect(selectTools(cls('Show slow moving SKUs'), 'management', TODAY).calls[0].params.focus).toBe('slow');
    expect(selectTools(cls('What needs attention today?'), 'management', TODAY).calls).toHaveLength(8);
  });

  it('selects nothing for unknown questions', () => {
    expect(selectTools(cls('tell me a joke'), 'management', TODAY).calls).toEqual([]);
  });

  it('never selects a tool outside the category or the role', () => {
    for (const role of ROLES) {
      for (const q of ['What needs attention today?', 'Which invoices are overdue?', 'What is expected cash flow this month?', 'Which suppliers have delayed POs?', 'Which marketplace orders are blocked?', 'What stock will run out soon?', 'Which sales orders need attention today?', 'Why is SO-1021 blocked?', 'What are the dispatch deadlines today?']) {
        const c = cls(q);
        const sel = selectTools(c, role, TODAY);
        for (const call of sel.calls) {
          expect(CATEGORY_TOOLS[c.category], `${q}`).toContain(call.tool);
          expect(canUseTool(role, call.tool), `${role}/${call.tool}`).toBe(true);
        }
        for (const t of sel.blockedByRole) expect(canUseTool(role, t)).toBe(false);
      }
    }
  });

  it('uses the stronger model for management analysis and the cheaper one for routine questions', () => {
    expect(isComplexQuestion(cls('What needs attention today?'), 8)).toBe(true);
    // A "why" question about ONE record is routine: the stronger model is for management analysis (PDF section 3).
    expect(isComplexQuestion(cls('Why is SO-1021 blocked?'), 1)).toBe(false);
    expect(isComplexQuestion(cls('Give me the daily business summary'), 8)).toBe(true);
    expect(isComplexQuestion(cls('Which invoices are overdue?'), 1)).toBe(false);
  });
});

describe('permission matrix (Task 6)', () => {
  it('Checker has exactly one data tool (approvals); Sales has no marketplace tool; Finance has no sales-order tool', () => {
    expect(TOOL_NAMES.filter((t) => canUseTool('checker', t))).toEqual(['getPendingApprovals']);
    expect(canUseTool('sales', 'getMarketplaceExceptions')).toBe(false);
    expect(canUseTool('finance', 'getOpenSalesOrders')).toBe(false);
    expect(canAccessRecord('checker', 'sales-orders')).toBe(false);
    expect(canAccessRecord('sales', 'products')).toBe(false);
    expect(FIELD_PERMISSIONS.customer_credit).not.toContain('checker');
  });

  it('maps every tool to at least one role and always allows management', () => {
    for (const t of TOOL_NAMES) {
      expect(TOOL_PERMISSIONS[t].length).toBeGreaterThan(0);
    }
    for (const t of TOOL_NAMES.filter((t) => t !== 'getPendingApprovals' || true)) expect(canUseTool('management', t)).toBe(true);
  });

  it('matches the spec: each role gets only its own area', () => {
    expect(canUseTool('sales', 'getOpenSalesOrders') && canUseTool('sales', 'getOverdueInvoices')).toBe(true);
    expect(canUseTool('sales', 'getCashFlowSummary')).toBe(false);
    expect(canUseTool('procurement', 'getDelayedPurchaseOrders')).toBe(true);
    expect(canUseTool('procurement', 'getOverdueInvoices')).toBe(false);
    expect(canUseTool('warehouse', 'getPendingWarehouseTasks')).toBe(true);
    expect(canUseTool('warehouse', 'getCashFlowSummary')).toBe(false);
    expect(canUseTool('finance', 'getCashFlowSummary') && canUseTool('finance', 'getOverdueInvoices')).toBe(true);
    expect(canUseTool('finance', 'getOpenSalesOrders')).toBe(false);
    expect(canUseTool('checker', 'getPendingApprovals')).toBe(true);
    expect(canUseTool('checker', 'getCashFlowSummary')).toBe(false);
  });

  it('finance-sensitive data is limited to finance and management', () => {
    expect([...FIELD_PERMISSIONS.settlement_values].sort()).toEqual(['finance', 'management']);
    for (const r of ROLES.filter((r) => r !== 'finance' && r !== 'management')) {
      expect(canUseTool(r, 'getCashFlowSummary')).toBe(false);
      expect(canAccessRecord(r, 'settlements')).toBe(false);
      expect(canAccessRecord(r, 'supplier-bills')).toBe(false);
    }
  });

  it('ToolGate blocks tools outside the category even for management', () => {
    expect(() => new ToolGate('management', 'sales').assertAllowed('getCashFlowSummary')).toThrow(/not approved/);
    expect(() => new ToolGate('management', 'unknown').assertAllowed('getOpenSalesOrders')).toThrow(/not approved/);
    expect(() => new ToolGate('sales', 'finance').assertAllowed('getCashFlowSummary')).toThrow(/not permitted/);
    expect(() => new ToolGate('finance', 'finance').assertAllowed('getCashFlowSummary')).not.toThrow();
  });

  it('exposes the matrix for documentation', () => {
    expect(Object.keys(permissionMatrix().roles)).toHaveLength(6);
  });
});

describe('backend enforcement of the matrix (cross-role leakage)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.cleanup());

  const forbidden: [Role, string][] = [
    ['sales', 'What is expected cash flow this month?'],
    ['sales', 'Which suppliers have delayed POs?'],
    ['sales', 'What stock will run out soon?'],
    ['sales', 'What are the dispatch deadlines today?'],
    ['procurement', 'Which sales orders need attention today?'],
    ['procurement', 'Which invoices are overdue?'],
    ['procurement', 'What is expected cash flow this month?'],
    ['warehouse', 'Which invoices are overdue?'],
    ['warehouse', 'What is expected cash flow this month?'],
    ['warehouse', 'Which sales orders need attention today?'],
    ['warehouse', 'Which suppliers have delayed POs?'],
    ['finance', 'Which sales orders need attention today?'],
    ['finance', 'Which suppliers have delayed POs?'],
    ['finance', 'What are the dispatch deadlines today?'],
    ['checker', 'What is expected cash flow this month?'],
    ['checker', 'Which invoices are overdue?'],
    ['checker', 'What stock will run out soon?'],
    // PDF section 8 is applied literally: Checker = pending approvals and exceptions only.
    ['checker', 'Which sales orders need attention today?'],
    ['checker', 'Why is SO-1030 blocked?'],
    ['checker', 'Which marketplace orders are blocked?'],
    // Marketplace operations are not assigned to Sales; settlements belong to Finance.
    ['sales', 'Which marketplace orders are blocked?'],
    ['sales', 'Which marketplace settlements are short?'],
    ['warehouse', 'Which marketplace orders are blocked?'],
    ['procurement', 'Which marketplace settlements are short?'],
  ];
  it.each(forbidden)('%s asking "%s" is refused with 403 and no data', async (role, q) => {
    const token = await env.as(role);
    const res = await ask(env, token, q);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_NOT_PERMITTED');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/₹\d|INV-\d|PO-\d|SO-\d|SKU-\d/);
  });

  const allowed: [Role, string][] = [
    ['sales', 'Which sales orders need attention today?'],
    ['sales', 'Which invoices above ₹1 lakh are overdue?'],
    ['sales', 'Why is SO-1021 waiting?'],
    ['procurement', 'Which Purchase Orders are delayed?'],
    ['procurement', 'What stock will run out soon?'],
    ['warehouse', 'What are the dispatch deadlines today?'],
    ['warehouse', 'What stock will run out soon?'],
    ['finance', 'Which invoices are overdue?'],
    ['finance', 'What is expected cash flow this month?'],
    ['finance', 'Which marketplace settlements are short?'],
    ['finance', 'Which settlements are short?'],
    ['finance', 'Which marketplace orders are waiting for an invoice?'],
    ['checker', 'What approvals are pending?'],
    ['checker', 'Which approvals are exceptions?'],
  ];
  it.each(allowed)('%s asking "%s" is answered with sources', async (role, q) => {
    const token = await env.as(role);
    const res = await ask(env, token, q);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sources.length).toBeGreaterThan(0);
  });

  it('a broad management question is narrowed to the role’s own data and discloses what was left out', async () => {
    const token = await env.as('sales');
    const res = await ask(env, token, 'What needs attention today?');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/BILL-|WT-9|PO-30|SKU-1006|inflows|ST-AMZ|EVT-|MP-/i);
    expect(res.body.items.every((i: any) => ['sales-orders', 'invoices'].includes(i.source.type))).toBe(true);
    expect(res.body.missingData.join(' ')).toMatch(/not permitted/);
  });

  it('keeps settlement figures away from Sales entirely, and mapping/API data away from Finance', async () => {
    const sales = await ask(env, await env.as('sales'), 'Which marketplace settlements are short?');
    expect(sales.status).toBe(403);
    expect(JSON.stringify(sales.body)).not.toMatch(/12,800|3,72,200|₹\d/);
    const fin = await ask(env, await env.as('finance'), 'Which marketplace settlements are short?');
    expect(fin.status).toBe(200);
    const text = JSON.stringify(fin.body);
    expect(text).toContain('12,800');
    expect(text).not.toMatch(/FK-BTL-NEW|EVT-400|unmapped|SKU-1008/i);
    expect(fin.body.missingData.join(' ')).toContain('outside Finance access');
  });

  it('routes a finance "settlements" question to the settlement data without needing the word marketplace', async () => {
    const sel = selectTools(cls('Which settlements are short?'), 'finance', TODAY).calls.map((c) => c.tool);
    expect(sel).toContain('getMarketplaceExceptions');
    const res = await ask(env, await env.as('finance'), 'Which settlements are short?');
    expect(JSON.stringify(res.body)).toContain('ST-AMZ-2410');
  });

  it('a tampered token cannot claim another role or client', async () => {
    const jwt = await import('jsonwebtoken');
    const login = await request(env.app).post('/api/auth/login').send({ email: 'sales@aarav.demo', password: 'Test@12345' });
    const salesId = login.body.user.id;
    const forged = jwt.sign({ sub: salesId, role: 'management', clientId: 2 }, env.config.jwtSecret, { expiresIn: '1h' });
    const res = await ask(env, forged, 'What is expected cash flow this month?');
    expect(res.status).toBe(403);
    const wrongSecret = jwt.sign({ sub: salesId }, 'some-other-secret-some-other-secret-1234', { expiresIn: '1h' });
    expect((await ask(env, wrongSecret, 'Which invoices are overdue?')).status).toBe(401);
    expect((await ask(env, jwt.sign({ sub: 987654 }, env.config.jwtSecret), 'Which invoices are overdue?')).status).toBe(401);
    expect((await ask(env, jwt.sign({ sub: salesId }, env.config.jwtSecret, { expiresIn: -10 }), 'Which invoices are overdue?')).status).toBe(401);
  });
});
