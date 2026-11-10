/**
 * Link to the Adventra platform (the real WhizUnik product this AI layer ships inside).
 *
 * The stand-in record screens in this reference build mirror records that live in Adventra. When
 * VITE_ADVENTRA_URL is set (e.g. https://adventra.whizunikhub.com) each record gets an "Open in Adventra" link to
 * the matching Adventra workflow screen. Paths mirror `RECORD_META` in Adventra's backend
 * (services/ai-record-links.ts); Adventra's own AI answers deep-link to the individual record.
 */
export const ADVENTRA_URL: string = ((import.meta.env.VITE_ADVENTRA_URL as string | undefined) ?? '').replace(/\/+$/, '');

const WORKFLOW_PATH: Record<string, { label: string; path: string }> = {
  'sales-orders': { label: 'Sales Workbench', path: '/app/sales-workbench' },
  invoices: { label: 'Invoice queue', path: '/app/invoices' },
  products: { label: 'Warehouse Control', path: '/app/warehouse-workbench' },
  'purchase-orders': { label: 'Procurement Workbench', path: '/app/procurement-workbench' },
  'warehouse-tasks': { label: 'Warehouse Control', path: '/app/warehouse-workbench' },
  'marketplace-orders': { label: 'Marketplace Hub', path: '/app/amazon-dashboard' },
  settlements: { label: 'Returns & Settlements', path: '/app/amazon-returns-settlement' },
  approvals: { label: 'Checker Workbench', path: '/app/checker' },
  'supplier-bills': { label: 'Purchase invoices', path: '/app/purchases' },
  'api-events': { label: 'Marketplace Exceptions', path: '/app/amazon-exceptions' },
};

/** The Adventra screen for a record type, or null when no Adventra URL is configured / the type is unknown. */
export function adventraScreen(recordType: string): { label: string; href: string } | null {
  const w = WORKFLOW_PATH[recordType];
  if (!ADVENTRA_URL || !w) return null;
  return { label: w.label, href: `${ADVENTRA_URL}${w.path}` };
}
