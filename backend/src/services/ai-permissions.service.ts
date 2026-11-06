import type { Category, FieldClass, RecordType, Role, ToolName } from '../types';
import { AppError } from '../errors';

/**
 * Permission matrix for the AI layer (spec section 8 / Task 6).
 *
 * The BACKEND enforces this on every request. Hiding things in the frontend is
 * a convenience only — it is never relied on for security.
 */

export const ROLE_DESCRIPTIONS: Record<Role, { label: string; access: string }> = {
  management: { label: 'Management', access: 'Cross-department summaries' },
  sales: { label: 'Sales', access: 'Sales orders, customers and collections' },
  procurement: { label: 'Procurement', access: 'Suppliers, Purchase Orders and purchasing' },
  warehouse: { label: 'Warehouse', access: 'Stock, dispatch and warehouse tasks' },
  finance: { label: 'Finance', access: 'Invoices, receipts, settlements and cash flow' },
  checker: { label: 'Checker', access: 'Pending approvals and exceptions' },
};

/** Which roles may use which approved data tool. */
export const TOOL_PERMISSIONS: Record<ToolName, readonly Role[]> = {
  getOpenSalesOrders: ['management', 'sales'],
  getSalesOrderDetail: ['management', 'sales'],
  getOverdueInvoices: ['management', 'sales', 'finance'],
  getLowStockProducts: ['management', 'procurement', 'warehouse'],
  getDelayedPurchaseOrders: ['management', 'procurement'],
  getPendingWarehouseTasks: ['management', 'warehouse'],
  // Marketplace data is not assigned to a role in the PDF except settlements (Finance); Finance gets only the
  // settlement / invoice parts of this tool (see getMarketplaceExceptions), Management gets everything.
  getMarketplaceExceptions: ['management', 'finance'],
  getCashFlowSummary: ['management', 'finance'],
  getPendingApprovals: ['management', 'checker'],
};

/** Sensitive field classes that are stripped from tool output for other roles. */
export const FIELD_PERMISSIONS: Record<FieldClass, readonly Role[]> = {
  unit_cost: ['management', 'procurement', 'finance'],
  supplier_pricing: ['management', 'procurement'],
  settlement_values: ['management', 'finance'],
  customer_credit: ['management', 'finance', 'sales'],
};

/** Record types a role may open from an AI source link. */
export const RECORD_ACCESS: Record<RecordType, readonly Role[]> = {
  'sales-orders': ['management', 'sales'],
  invoices: ['management', 'sales', 'finance'],
  products: ['management', 'procurement', 'warehouse'],
  'purchase-orders': ['management', 'procurement'],
  'warehouse-tasks': ['management', 'warehouse'],
  'marketplace-orders': ['management', 'finance'],
  settlements: ['management', 'finance'],
  approvals: ['management', 'checker'],
  'supplier-bills': ['management', 'finance'],
  'api-events': ['management'],
};

/**
 * Tools approved for each question category (Task 5). The model never chooses
 * tools: the backend picks them from this list and then intersects with the
 * role permissions.
 */
export const CATEGORY_TOOLS: Record<Category, readonly ToolName[]> = {
  sales: ['getOpenSalesOrders', 'getSalesOrderDetail', 'getOverdueInvoices'],
  procurement: ['getDelayedPurchaseOrders', 'getLowStockProducts'],
  inventory: ['getLowStockProducts'],
  warehouse: ['getPendingWarehouseTasks'],
  finance: ['getOverdueInvoices', 'getCashFlowSummary', 'getMarketplaceExceptions'], // settlements are Finance intelligence (PDF section 5)
  marketplace: ['getMarketplaceExceptions'],
  management: [
    'getOpenSalesOrders',
    'getOverdueInvoices',
    'getLowStockProducts',
    'getDelayedPurchaseOrders',
    'getPendingWarehouseTasks',
    'getMarketplaceExceptions',
    'getCashFlowSummary',
    'getPendingApprovals',
  ],
  unknown: [],
};

/** Plain-language names used in messages shown to users (never raw function names). */
export const TOOL_LABELS: Record<ToolName, string> = {
  getOpenSalesOrders: 'sales orders',
  getSalesOrderDetail: 'sales order details',
  getOverdueInvoices: 'overdue invoices',
  getLowStockProducts: 'stock and inventory',
  getDelayedPurchaseOrders: 'purchase orders and suppliers',
  getPendingWarehouseTasks: 'warehouse tasks',
  getMarketplaceExceptions: 'marketplace exceptions',
  getCashFlowSummary: 'cash flow and payments',
  getPendingApprovals: 'pending approvals',
};

export function canUseTool(role: Role, tool: ToolName): boolean {
  return TOOL_PERMISSIONS[tool].includes(role);
}

export function canSeeField(role: Role, field: FieldClass): boolean {
  return FIELD_PERMISSIONS[field].includes(role);
}

export function canAccessRecord(role: Role, type: RecordType): boolean {
  return RECORD_ACCESS[type].includes(role);
}

export function toolsForRole(role: Role): ToolName[] {
  return (Object.keys(TOOL_PERMISSIONS) as ToolName[]).filter((t) => canUseTool(role, t));
}

/**
 * Every data-tool call goes through the gate. A call is allowed only when the
 * tool is approved for the question category AND permitted for the user's role.
 */
export class ToolGate {
  constructor(
    private readonly role: Role,
    private readonly category: Category,
  ) {}

  isAllowed(tool: ToolName): boolean {
    return CATEGORY_TOOLS[this.category].includes(tool) && canUseTool(this.role, tool);
  }

  assertAllowed(tool: ToolName): void {
    if (!CATEGORY_TOOLS[this.category].includes(tool)) {
      throw new AppError('UNAUTHORISED_TOOL', 403, `Tool ${tool} is not approved for ${this.category} questions.`, { tool });
    }
    if (!canUseTool(this.role, tool)) {
      throw new AppError('UNAUTHORISED_TOOL', 403, `Your role is not permitted to use ${tool}.`, { tool });
    }
  }
}

export function permissionMatrix() {
  return {
    roles: ROLE_DESCRIPTIONS,
    tools: TOOL_PERMISSIONS,
    fields: FIELD_PERMISSIONS,
    records: RECORD_ACCESS,
    categories: CATEGORY_TOOLS,
  };
}
