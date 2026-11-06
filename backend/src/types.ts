import type { Database } from 'better-sqlite3';

export const ROLES = ['management', 'sales', 'procurement', 'warehouse', 'finance', 'checker'] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = [
  'sales',
  'procurement',
  'inventory',
  'warehouse',
  'finance',
  'marketplace',
  'management',
  'unknown',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const TOOL_NAMES = [
  'getOpenSalesOrders',
  'getSalesOrderDetail',
  'getOverdueInvoices',
  'getLowStockProducts',
  'getDelayedPurchaseOrders',
  'getPendingWarehouseTasks',
  'getMarketplaceExceptions',
  'getCashFlowSummary',
  'getPendingApprovals',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const RECORD_TYPES = [
  'sales-orders',
  'invoices',
  'products',
  'purchase-orders',
  'warehouse-tasks',
  'marketplace-orders',
  'settlements',
  'approvals',
  'supplier-bills',
  'api-events',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Data classes that can be hidden field-by-field for a role. */
export type FieldClass = 'unit_cost' | 'supplier_pricing' | 'settlement_values' | 'customer_credit';

export type Severity = 'high' | 'medium' | 'low';

export interface AuthUser {
  id: number;
  clientId: number;
  role: Role;
  name: string;
  email: string;
}

export type Db = Database;

/** A link from an AI answer back to the original WhizUnik record. */
export interface SourceRef {
  type: RecordType;
  ref: string;
  label: string;
  link: string;
  workflow: { label: string; link: string };
}
