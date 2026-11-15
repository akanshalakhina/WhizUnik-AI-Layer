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
  companyId?: string;
  tenantId?: string;
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

// ---------------------------------------------------------------- WhizUnik AI RAG Types
export const RAG_DEPARTMENTS = [
  'Sales',
  'Procurement',
  'Finance',
  'Warehouse',
  'Inventory',
  'Returns',
  'Tally',
  'Marketplace',
  'Management reporting',
  'General platform help',
] as const;
export type RagDepartment = (typeof RAG_DEPARTMENTS)[number];

export const RAG_SOURCE_TYPES = ['workflow', 'sop', 'policy', 'manual_qa', 'platform_doc'] as const;
export type RagSourceType = (typeof RAG_SOURCE_TYPES)[number];

export const RAG_APPROVED_STATUSES = [
  'uploaded',
  'processing',
  'pending_review',
  'approved',
  'rejected',
  'archived',
  'failed',
  'deleted',
] as const;
export type RagApprovedStatus = (typeof RAG_APPROVED_STATUSES)[number];

export interface RagCitation {
  documentId: string;
  title: string;
  department: string;
  version: number;
  section?: string;
  excerpt?: string;
}

export interface RagAskResponse {
  answer: string;
  answerStatus: 'grounded' | 'insufficient_evidence' | 'clarification_needed';
  citations: RagCitation[];
  confidence: number;
  intent?: string;
  department?: string;
  entities?: Record<string, string>;
  clarificationQuestion?: string | null;
  conversationId: string;
  messageId: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costInr: number;
  };
}

