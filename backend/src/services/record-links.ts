import type { RecordType, SourceRef } from '../types';

/** Where each record type lives in the WhizUnik workflow UI. */
export const RECORD_META: Record<RecordType, { label: string; workflowLabel: string }> = {
  'sales-orders': { label: 'Sales Order', workflowLabel: 'Sales Orders queue' },
  invoices: { label: 'Invoice', workflowLabel: 'Invoices & collections' },
  products: { label: 'Product / SKU', workflowLabel: 'Inventory' },
  'purchase-orders': { label: 'Purchase Order', workflowLabel: 'Procurement queue' },
  'warehouse-tasks': { label: 'Warehouse Task', workflowLabel: 'Warehouse queue' },
  'marketplace-orders': { label: 'Marketplace Order', workflowLabel: 'Marketplace orders' },
  settlements: { label: 'Marketplace Settlement', workflowLabel: 'Marketplace settlements' },
  approvals: { label: 'Approval', workflowLabel: 'Checker approvals' },
  'supplier-bills': { label: 'Supplier Bill', workflowLabel: 'Supplier payments' },
  'api-events': { label: 'Marketplace API event', workflowLabel: 'Marketplace API log' },
};

export function workflowFor(type: RecordType): { label: string; link: string } {
  return { label: RECORD_META[type].workflowLabel, link: `/records/${type}` };
}

export function sourceRef(type: RecordType, ref: string, label?: string): SourceRef {
  return {
    type,
    ref,
    label: label ? `${ref} · ${label}` : ref,
    link: `/records/${type}/${encodeURIComponent(ref)}`,
    workflow: workflowFor(type),
  };
}
