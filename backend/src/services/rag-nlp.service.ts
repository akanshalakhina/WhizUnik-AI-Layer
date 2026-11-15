import type { RagDepartment } from '../types';

export interface ExtractedEntities {
  supplier?: string;
  customer?: string;
  sku?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  period?: string;
  amount?: number;
  [key: string]: string | number | undefined;
}

export interface NlpAnalysisResult {
  intent: string;
  department: RagDepartment;
  entities: ExtractedEntities;
  responseType: 'workflow_steps' | 'aggregate_balance' | 'status_check' | 'policy' | 'clarification';
  isAmbiguous: boolean;
  clarificationQuestion?: string;
  keywords: string[];
}

export class RagNlpService {
  /**
   * Classify user question before retrieval.
   * Identifies intent, department, entities, dates, and whether clarification is needed.
   */
  analyze(question: string, departmentHint?: string): NlpAnalysisResult {
    const q = question.trim();
    const lower = q.toLowerCase();

    // Check for extreme ambiguity
    if (q.length < 4 || /^(cancel|status|help|how much|details|show me|run|do it|what)$/i.test(q)) {
      return {
        intent: 'ambiguous_request',
        department: (departmentHint as RagDepartment) || 'General platform help',
        entities: {},
        responseType: 'clarification',
        isAmbiguous: true,
        clarificationQuestion:
          'Could you please specify which process, order, or document you need assistance with (for example: damaged customer returns, sales orders, GST on invoices, or GRN creation)?',
        keywords: [lower],
      };
    }

    const entities: ExtractedEntities = {};

    // Extract Order Numbers (SO-1021, PO-3001, MP-AMZ-7001, etc.)
    const soMatch = q.match(/\b(SO-\d+)\b/i);
    if (soMatch) entities.orderNumber = soMatch[1].toUpperCase();

    const poMatch = q.match(/\b(PO-\d+)\b/i);
    if (poMatch) entities.orderNumber = poMatch[1].toUpperCase();

    const invMatch = q.match(/\b(INV-\d+)\b/i);
    if (invMatch) entities.invoiceNumber = invMatch[1].toUpperCase();

    const rmaMatch = q.match(/\b(RMA-\d+)\b/i);
    if (rmaMatch) entities.orderNumber = rmaMatch[1].toUpperCase();

    // Extract SKUs
    const skuMatch = q.match(/\b(LATEX-EXAM-100|NITRILE-PF-200|SKU-\d+|RAW-CHEM-\d+)\b/i);
    if (skuMatch) entities.sku = skuMatch[1].toUpperCase();

    // Extract Period / Dates
    if (/this month|current month/i.test(lower)) {
      entities.period = 'current month';
    } else if (/today/i.test(lower)) {
      entities.period = 'today';
    } else if (/this week/i.test(lower)) {
      entities.period = 'this week';
    } else if (/overdue/i.test(lower)) {
      entities.period = 'overdue';
    }

    // Extract Known Suppliers / Customers
    const supplierMatch = q.match(/\b(ABC Raw Materials|Shree Steelware|Textura Mills|Metalware Hub|Ceramica Exports|Bamboo Craft|PackRight Solutions)\b/i);
    if (supplierMatch) entities.supplier = supplierMatch[1];

    const customerMatch = q.match(/\b(Sunrise Retail Mart|Metro Lifestyle Stores|Greenleaf Organics|Urban Nest Interiors|Kaveri Distributors|Orbit Electronics Hub)\b/i);
    if (customerMatch) entities.customer = customerMatch[1];

    // Intent and Department classification rules
    let intent = 'general_help';
    let department: RagDepartment = 'General platform help';
    let responseType: NlpAnalysisResult['responseType'] = 'workflow_steps';

    if (/damaged.*return|return.*damaged|damaged goods/i.test(lower)) {
      intent = 'damaged_return';
      department = 'Returns';
    } else if (/customer return|goods.*return|return.*goods/i.test(lower)) {
      intent = 'customer_return';
      department = 'Returns';
    } else if (/marketplace return/i.test(lower)) {
      intent = 'marketplace_returns';
      department = 'Returns';
    } else if (/how much.*owe|outstanding.*supplier|balance.*due|supplier.*balance/i.test(lower)) {
      intent = 'supplier_balance';
      department = 'Finance';
      responseType = 'aggregate_balance';
    } else if (/customer receipt|record.*receipt/i.test(lower)) {
      intent = 'customer_receipt';
      department = 'Finance';
    } else if (/supplier payment|record.*supplier payment|pay.*supplier/i.test(lower)) {
      intent = 'supplier_payment';
      department = 'Finance';
    } else if (/gst.*invoice|how is gst shown|tax.*invoice/i.test(lower)) {
      intent = 'gst_display';
      department = 'Finance';
    } else if (/when is.*invoice generated|invoice.*workflow/i.test(lower)) {
      intent = 'invoice_generation';
      department = 'Finance';
    } else if (/credit note.*linked|linked.*credit note|link.*original invoice/i.test(lower)) {
      intent = 'credit_note_linkage';
      department = 'Finance';
    } else if (/refund recorded|record.*refund/i.test(lower)) {
      intent = 'marketplace_refund';
      department = 'Finance';
    } else if (/credit note.*created|create.*credit note/i.test(lower)) {
      intent = 'create_credit_note';
      department = 'Finance';
    } else if (/create.*sales order|how do i create a sales order/i.test(lower)) {
      intent = 'create_sales_order';
      department = 'Sales';
    } else if (/tally.*connector|tally connector work|tally sync/i.test(lower)) {
      intent = 'tally_sync_status';
      department = 'Tally';
    } else if (/stock.*deducted|when is stock deducted/i.test(lower)) {
      intent = 'stock_deduction';
      department = 'Inventory';
    } else if (/stock.*reserved|how is stock reserved/i.test(lower)) {
      intent = 'stock_reservation';
      department = 'Inventory';
    } else if (/process.*marketplace order|marketplace order/i.test(lower)) {
      intent = 'marketplace_order';
      department = 'Marketplace';
    } else if (/purchase raw material|purchase.*material/i.test(lower)) {
      intent = 'purchase_raw_material';
      department = 'Procurement';
    } else if (/grn.*created|how is a grn created|goods receipt note/i.test(lower)) {
      intent = 'create_grn';
      department = 'Warehouse';
    } else if (/material issued for production|material.*issue/i.test(lower)) {
      intent = 'issue_material';
      department = 'Warehouse';
    } else if (/finished goods stock updated|finished goods/i.test(lower)) {
      intent = 'update_finished_goods';
      department = 'Warehouse';
    } else if (/track warehouse movement|warehouse movement/i.test(lower)) {
      intent = 'warehouse_transfer';
      department = 'Warehouse';
    }

    // If user explicitly provided a department hint that matches our taxonomy, respect it unless strong intent overrides
    if (departmentHint && departmentHint !== 'all' && departmentHint !== 'General platform help') {
      const hint = departmentHint as RagDepartment;
      if (department === 'General platform help') {
        department = hint;
      }
    }

    // Generate keywords for hybrid search
    const words = lower
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['how', 'what', 'when', 'why', 'who', 'the', 'and', 'for', 'with', 'from', 'does', 'this'].includes(w));

    return {
      intent,
      department,
      entities,
      responseType,
      isAmbiguous: false,
      keywords: Array.from(new Set(words)),
    };
  }
}

