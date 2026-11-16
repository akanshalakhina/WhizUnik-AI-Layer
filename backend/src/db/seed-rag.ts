import bcrypt from 'bcryptjs';
import type { Db, RagDepartment } from '../types';
import { RagVectorService } from '../services/rag-vector.service';
import { RagKnowledgeService } from '../services/rag-knowledge.service';
import type { AppConfig } from '../config';

export function seedRagData(db: Db, config: AppConfig, password = 'Demo@12345') {
  const vectorService = new RagVectorService(config);
  const knowledgeService = new RagKnowledgeService(db, vectorService);
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();

  // 1. Seed the Three Demo Companies in rag_companies & clients
  const companies = [
    {
      companyId: 'company-rfb-latex',
      tenantId: 'tenant-rfb-latex',
      name: 'RFB Latex',
      industry: 'Medical gloves manufacturing',
    },
    {
      companyId: 'company-alpine-retail',
      tenantId: 'tenant-alpine-retail',
      name: 'Alpine Retail',
      industry: 'Consumer retail and marketplace',
    },
    {
      companyId: 'company-demo-mfg',
      tenantId: 'tenant-demo-mfg',
      name: 'Demo Manufacturing Co.',
      industry: 'Industrial equipment manufacturing',
    },
  ];

  for (const c of companies) {
    db.prepare(`
      INSERT OR REPLACE INTO rag_companies (company_id, tenant_id, name, industry, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(c.companyId, c.tenantId, c.name, c.industry, now, now);

    // Also ensure client row exists in clients table with matching company_id & tenant_id
    const existing = db.prepare('SELECT id FROM clients WHERE company_id = ?').get(c.companyId) as { id: number } | undefined;
    if (!existing) {
      db.prepare(`
        INSERT INTO clients (name, company_id, tenant_id, industry, plan, cash_balance, ai_enabled, ai_permitted_roles)
        VALUES (?, ?, ?, ?, 'standard', 1000000, 1, '["management","sales","procurement","warehouse","finance","checker"]')
      `).run(c.name, c.companyId, c.tenantId, c.industry);
    } else {
      db.prepare('UPDATE clients SET name = ?, tenant_id = ?, industry = ?, ai_enabled = 1 WHERE id = ?').run(
        c.name,
        c.tenantId,
        c.industry,
        existing.id,
      );
    }
  }

  // 2. Seed Users for each Demo Company
  const usersToSeed = [
    // RFB Latex
    { email: 'admin@rfblatex.demo', name: 'RFB Admin', role: 'management', companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' },
    { email: 'finance@rfblatex.demo', name: 'RFB Finance Manager', role: 'finance', companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' },
    { email: 'returns@rfblatex.demo', name: 'RFB Returns Lead', role: 'checker', companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' },
    { email: 'sales@rfblatex.demo', name: 'RFB Sales Lead', role: 'sales', companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' },
    { email: 'warehouse@rfblatex.demo', name: 'RFB Warehouse Officer', role: 'warehouse', companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' },

    // Alpine Retail
    { email: 'admin@alpineretail.demo', name: 'Alpine Admin', role: 'management', companyId: 'company-alpine-retail', tenantId: 'tenant-alpine-retail' },
    { email: 'marketplace@alpineretail.demo', name: 'Alpine Marketplace Lead', role: 'sales', companyId: 'company-alpine-retail', tenantId: 'tenant-alpine-retail' },
    { email: 'finance@alpineretail.demo', name: 'Alpine Finance Manager', role: 'finance', companyId: 'company-alpine-retail', tenantId: 'tenant-alpine-retail' },

    // Demo Manufacturing Co.
    { email: 'admin@demomfg.demo', name: 'Mfg Admin', role: 'management', companyId: 'company-demo-mfg', tenantId: 'tenant-demo-mfg' },
    { email: 'procurement@demomfg.demo', name: 'Mfg Procurement Lead', role: 'procurement', companyId: 'company-demo-mfg', tenantId: 'tenant-demo-mfg' },
    { email: 'warehouse@demomfg.demo', name: 'Mfg Plant Officer', role: 'warehouse', companyId: 'company-demo-mfg', tenantId: 'tenant-demo-mfg' },
  ];

  for (const u of usersToSeed) {
    const client = db.prepare('SELECT id FROM clients WHERE company_id = ?').get(u.companyId) as { id: number };
    db.prepare(`
      INSERT OR REPLACE INTO users (client_id, company_id, tenant_id, name, email, password_hash, role, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(client.id, u.companyId, u.tenantId, u.name, u.email, hash, u.role);
  }

  // Live demo data for supplier balance questions (ABC Raw Materials: POs and unpaid supplier bills)
  ensureSupplierDemoData(db);

  // 3. Seed RFB Latex Approved Knowledge Documents
  const rfbDocs = [
    {
      documentId: 'doc-rfb-returns-001',
      title: 'RFB Latex Customer Returns & Damaged Goods SOP',
      department: 'Returns',
      content: `## RFB Latex Customer Returns and Damaged Goods SOP
Sentinel Marker: [SENTINEL-RFB-LATEX-SECRET-2026]

### Return Request & RMA Issuance
1. The customer must log a return request within 7 calendar days of delivery, providing original invoice number and clear photographic proof of damage or discrepancy.
2. The Returns Team validates the claim against dispatch records and issues an authorized Return Merchandise Authorization (RMA) ticket.
3. Goods returned without a valid RMA number will not be received at the warehouse gate.

### Physical Receipt & Quarantine Bay Q-2 Inspection
1. Upon arrival at the factory warehouse, returned cartons are scanned and routed directly to Quarantine Bay Q-2.
2. The Quality Assurance (QA) Inspector evaluates physical integrity, lot/batch numbers, and tamper seals.
3. Damaged goods are classified as either Transit Damage or Manufacturing Defect.

### Quarantine Scrap Disposition
1. Damaged medical gloves cannot be re-packed or returned to active inventory under any circumstance.
2. QA changes the item disposition to 'Quarantine Scrap' and posts a stock write-off to the Damaged Goods Ledger (account code 5040-DMG).
3. Scrap items are scheduled for certified biomedical disposal.

### Credit Note & Refund / Replacement Execution
1. Finance issues a Tax Credit Note referencing the original Tax Invoice number with reason code CR-DMG-01.
2. If replacement was requested: A zero-value Sales Order is auto-generated and dispatched with priority.
3. If refund was requested: Finance releases bank remittance within 3 business days of QA sign-off.`,
    },
    {
      documentId: 'doc-rfb-sales-001',
      title: 'RFB Latex Sales Order Creation Workflow',
      department: 'Sales',
      content: `## RFB Latex Sales Order Creation Workflow
### Creating a Sales Order
1. Navigate to Sales -> Orders -> Create Order in WhizUnik Hub.
2. Select the customer account. The system automatically fetches customer credit limit, current outstanding balance, and assigned pricing tier.
3. Select SKU: LATEX-EXAM-100 (Examination Latex Gloves) or NITRILE-PF-200 (Nitrile Powder-Free Gloves).
4. Specify box quantity, destination shipping address, and delivery date.
5. Save as 'Draft' to verify line-item pricing and freight terms.

### Credit Approval and Confirmation
1. If the order total exceeds the customer's available credit buffer, the order is locked with status 'Credit Approval Required'.
2. The Finance Manager or Checker must approve credit exceptions before warehouse allocation.
3. Once approved, the Sales Order status changes to 'Confirmed' and soft-reserves stock.`,
    },
    {
      documentId: 'doc-rfb-finance-001',
      title: 'RFB Latex Invoice & GST Display Workflow',
      department: 'Finance',
      content: `## RFB Latex Invoicing and GST Compliance Procedure
### Invoice Generation Timing
1. Customer tax invoices are generated automatically upon warehouse dispatch confirmation when the Gate Pass and e-Way Bill are generated.
2. Invoices cannot be generated prior to physical stock picking and serial packing.

### GST Display Rules
1. Intra-state supplies within Maharashtra are split into CGST (9%) + SGST (9%).
2. Inter-state supplies across state boundaries carry IGST (18%).
3. The invoice header explicitly displays customer GSTIN, RFB Latex GSTIN (27AAACR1234F1Z8), and HSN code 4015 for medical examination gloves.
4. Taxable value, tax breakup by rate, and round-off adjustment are clearly itemized in the invoice summary.`,
    },
    {
      documentId: 'doc-rfb-finance-002',
      title: 'RFB Latex Customer Receipt Workflow',
      department: 'Finance',
      content: `## RFB Latex Customer Receipts Procedure
### Recording a Customer Receipt
1. Open Finance -> Receipts -> New Receipt in WhizUnik Hub.
2. Select the paying customer name and choose payment mode (NEFT, RTGS, IMPS, or Cheque).
3. Enter the transaction reference / UTR number, bank account credited, and receipt amount.
4. Select outstanding sales invoices from the unpaid invoice list to knock off against the payment.
5. System posts receipt to Accounts Receivable sub-ledger and updates customer outstanding balance instantly.`,
    },
    {
      documentId: 'doc-rfb-finance-003',
      title: 'RFB Latex Credit Note Linkage Procedure',
      department: 'Finance',
      content: `## RFB Latex Credit Note and Original Invoice Linkage
### Linking Credit Notes to Original Tax Invoices
1. Navigate to Finance -> Credit Notes -> Create Credit Note.
2. Search and select the original Tax Invoice number in the 'Original Invoice Ref' field.
3. The system pulls the original GST tax rates, HSN codes, and unit prices to prevent tax mismatch.
4. Select reason code (e.g. CR-DMG-01 for damaged goods, or CR-RET-01 for commercial returns).
5. Upon approval, the credit note is automatically linked to the invoice ledger and adjusts the net receivable.`,
    },
    {
      documentId: 'doc-rfb-tally-001',
      title: 'RFB Latex Tally Connector Workflow',
      department: 'Tally',
      content: `## RFB Latex Tally Connector Integration Guide
### How the Tally Connector Works
1. WhizUnik connects to TallyPrime via XML over local/network port 9000 using Tally's XML Server gateway.
2. An automated sync job runs hourly, queuing approved Sales Invoices, Customer Receipts, Credit Notes, and Purchase Vouchers.
3. On successful receipt acknowledgment from Tally, the record status updates to 'Synced' and stores the Tally Master ID and Voucher GUID.
4. Failed sync items are routed to the Tally Exception Queue for audit review and manual re-post.`,
    },
    {
      documentId: 'doc-rfb-inv-001',
      title: 'RFB Latex Stock Deduction Procedure',
      department: 'Inventory',
      content: `## RFB Latex Stock Deduction and Dispatch Timing
### When Stock is Deducted
1. Soft Reservation: Stock is soft-reserved upon Sales Order confirmation to prevent double booking.
2. Physical Deduction: Physical stock deduction from main inventory occurs ONLY when the Gate Pass is marked 'Dispatched' by Security at the warehouse exit gate.
3. Order packing and staging does not deduct stock from the financial inventory ledger.`,
    },
    {
      documentId: 'doc-rfb-proc-001',
      title: 'RFB Latex Supplier Payment Workflow',
      department: 'Procurement',
      content: `## RFB Latex Supplier Payment Procedure
### Recording a Supplier Payment
1. Navigate to Finance -> Accounts Payable -> Supplier Payments.
2. Select the vendor (e.g. ABC Raw Materials) and verify approved 3-way matched Purchase Orders and Inward GRN invoices.
3. Apply statutory TDS deduction under Section 194Q or 194C as applicable.
4. Submit payment voucher for dual-level approval (Procurement Head + Finance Director).
5. Once approved, generate the bank payout file for NEFT/RTGS processing.`,
    },
  ];

  // 4. Seed Alpine Retail Approved Knowledge Documents
  const alpineDocs = [
    {
      documentId: 'doc-alp-mkt-001',
      title: 'Alpine Retail Marketplace Order Processing Workflow',
      department: 'Marketplace',
      content: `## Alpine Retail Marketplace Order Processing SOP
Sentinel Marker: [SENTINEL-ALPINE-RETAIL-SECRET-2026]

### Order Ingestion & Fulfillment
1. Orders from Amazon, Flipkart, and Shopify sync automatically into WhizUnik every 5 minutes via channel APIs.
2. Incoming orders arrive in 'Unfulfilled' status and immediately lock available inventory.
3. The Fulfillment Centre generates picking batches and prints marketplace-compliant shipping labels with tracking barcodes.
4. Packed parcels are scanned into manifest bays. When courier partners (Delhivery, BlueDart, ATS) scan handover, WhizUnik pushes tracking numbers and 'Shipped' status back to the marketplace.`,
    },
    {
      documentId: 'doc-alp-inv-001',
      title: 'Alpine Retail Stock Reservation Workflow',
      department: 'Inventory',
      content: `## Alpine Retail Stock Reservation and Multi-Channel Allocation
### How Stock is Reserved
1. When an order is placed on any online channel, the Available-to-Promise (ATP) pool decreases immediately by the order quantity.
2. The reserved stock is held in the 'Marketplace Reserve Buffer' for a maximum of 24 hours pending shipment.
3. If an order is canceled by the customer or courier pickup fails, the system automatically releases the reserved stock back into the active ATP pool.`,
    },
    {
      documentId: 'doc-alp-returns-001',
      title: 'Alpine Retail Marketplace Returns Handling SOP',
      department: 'Returns',
      content: `## Alpine Retail Marketplace Returns & RTO Management
### How Marketplace Returns are Handled
1. Returns arriving at the hub are identified by airway bill (AWB) or marketplace return tracking barcode.
2. Items are classified as either RTO (Return to Origin - unopened) or Customer Return (open box).
3. The QC team conducts barcode verification and physical inspection:
   - Grade A (unopened/pristine): Sanitized and returned to active marketplace inventory.
   - Grade B (damaged packaging): Routed to discount liquidation channel.
   - Damaged / counterfeit / wrong item: Photographed, logged for marketplace dispute claim, and marked as scrap.`,
    },
    {
      documentId: 'doc-alp-fin-001',
      title: 'Alpine Retail Refund Recording Workflow',
      department: 'Finance',
      content: `## Alpine Retail Refund Recording & Reconciliation
### How a Refund is Recorded
1. Marketplace gateway refunds are imported into WhizUnik weekly via marketplace settlement remittance files.
2. The Finance team runs automated reconciliation matching Marketplace Order ID against gateway processing fees, commission deductions, and net customer refunds.
3. Approved refunds post a debit entry to the Marketplace Escrow Clearing Account and adjust net channel sales.`,
    },
    {
      documentId: 'doc-alp-fin-002',
      title: 'Alpine Retail Credit Note Creation Procedure',
      department: 'Finance',
      content: `## Alpine Retail Marketplace Credit Note Creation
### Creating a Marketplace Credit Note
1. Open Finance -> Invoicing -> Marketplace Credit Notes.
2. Provide the original B2C Tax Invoice number or Marketplace Order ID.
3. System automatically calculates GST reversal and generates an e-Credit Note.
4. The credit note reference is pushed to the marketplace settlement report for reconciliation.`,
    },
  ];

  // 5. Seed Demo Manufacturing Co. Approved Knowledge Documents
  const mfgDocs = [
    {
      documentId: 'doc-mfg-proc-001',
      title: 'Demo Mfg Raw Material Procurement Workflow',
      department: 'Procurement',
      content: `## Demo Manufacturing Co. Raw Material Procurement Workflow
Sentinel Marker: [SENTINEL-DEMO-MFG-SECRET-2026]

### How Raw Material is Purchased
1. Material Requirement Planning (MRP) runs weekly based on active sales orders and production schedules, generating purchase requisitions for steel, polymers, and fasteners.
2. The Procurement Officer issues a Request for Quotation (RFQ) to at least 3 approved vendors.
3. A commercial comparative statement is created. The Purchase Order (PO) is generated in WhizUnik and submitted to the Plant Head for approval.
4. Once signed, the PO is dispatched via vendor portal with stipulated delivery dates and penalty terms for delays.`,
    },
    {
      documentId: 'doc-mfg-wh-001',
      title: 'Demo Mfg Goods Receipt Note (GRN) Creation SOP',
      department: 'Warehouse',
      content: `## Demo Manufacturing Co. Goods Receipt Note (GRN) SOP
### How a GRN is Created
1. Delivery vehicle reports to unloading gate with supplier delivery challan and invoice. Security enters vehicle number in Inward Gate Register.
2. The Warehouse Supervisor opens Procurement -> GRN -> Create GRN in WhizUnik.
3. Select the Purchase Order (PO) number. Enter received quantities, heat/batch certificates, and heat treatment numbers.
4. The system flags the consignment for QA Sampling Inspection.
5. Once QA logs chemical and dimensional approval, the GRN is finalized, updating raw material stock in the warehouse ledger.`,
    },
    {
      documentId: 'doc-mfg-prod-001',
      title: 'Demo Mfg Material Issue for Production Workflow',
      department: 'Warehouse',
      content: `## Demo Manufacturing Co. Material Issue Procedure
### How Material is Issued for Production
1. Production Supervisor generates a Material Issue Request (MIR) citing the active Work Order number.
2. Warehouse checks the MIR against the standard Bill of Materials (BOM).
3. Raw materials are picked, scanned, and physically transferred to the Shop Floor Staging Bay.
4. Warehouse confirms the issue in WhizUnik, which decrements Raw Material stock and increments Work-In-Progress (WIP) inventory.`,
    },
    {
      documentId: 'doc-mfg-prod-002',
      title: 'Demo Mfg Finished Goods Stock Update SOP',
      department: 'Warehouse',
      content: `## Demo Manufacturing Co. Finished Goods Stock Inwarding
### How Finished Goods Stock is Updated
1. Upon assembly and final QC testing, the Quality Engineer stamps the inspection certificate.
2. Production Supervisor closes the Work Order and issues a Finished Goods Transfer Note (FGTN).
3. Warehouse scans serial numbers at the Finished Goods Bay.
4. System automatically increments Finished Goods Inventory balance and decrements Work-In-Progress (WIP) ledger.`,
    },
    {
      documentId: 'doc-mfg-wh-002',
      title: 'Demo Mfg Warehouse Movement Tracking SOP',
      department: 'Warehouse',
      content: `## Demo Manufacturing Co. Warehouse Movement Tracking
### How Warehouse Movements are Tracked
1. Any transfer between Racks, Staging Bins, and Quarantine requires Handheld Terminal (HHT) barcode scanning.
2. The operator scans Source Bin barcode, item serial/lot barcode, and Destination Bin barcode.
3. WhizUnik updates the spatial warehouse map in real time, recording operator ID and timestamp in the Warehouse Transfer Ledger.`,
    },
  ];

  // Helper to ingest documents
  const allDocs = [
    ...rfbDocs.map((d) => ({ ...d, companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' })),
    ...alpineDocs.map((d) => ({ ...d, companyId: 'company-alpine-retail', tenantId: 'tenant-alpine-retail' })),
    ...mfgDocs.map((d) => ({ ...d, companyId: 'company-demo-mfg', tenantId: 'tenant-demo-mfg' })),
  ];

  for (const doc of allDocs) {
    // Check if document already exists
    const exists = db.prepare('SELECT document_id FROM rag_documents WHERE document_id = ?').get(doc.documentId);
    if (!exists) {
      knowledgeService.createDocument({
        documentId: doc.documentId,
        tenantId: doc.tenantId,
        companyId: doc.companyId,
        title: doc.title,
        department: doc.department as any,
        content: doc.content,
        createdBy: 'admin',
        approvedStatus: 'approved',
      });
    }
  }


  // 6. Seed / refresh the approved stored answers (all 21 demo questions, Developer Requirement p.7)
  syncSeededAnswers(db, knowledgeService);
}

/** Calendar date (YYYY-MM-DD) in India Standard Time. */
function istDay(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Demo live data for "How much do we owe ABC Raw Materials for invoices due this month?":
 * the supplier, two open purchase orders and their supplier bills (one partly paid, one due next month).
 * Idempotent: only missing rows are inserted.
 */
export function ensureSupplierDemoData(db: Db, now: Date = new Date()) {
  const rfbClient = db.prepare("SELECT id FROM clients WHERE company_id = 'company-rfb-latex'").get() as { id: number } | undefined;
  if (!rfbClient) return;
  const existing = db.prepare("SELECT id FROM suppliers WHERE client_id = ? AND name = 'ABC Raw Materials'").get(rfbClient.id) as { id: number } | undefined;
  const supplierId =
    existing?.id ??
    Number(
      db
        .prepare(`INSERT INTO suppliers (client_id, name, lead_time_days, contact_email) VALUES (?, 'ABC Raw Materials', 7, 'ap@abcrawmaterials.example')`)
        .run(rfbClient.id).lastInsertRowid,
    );

  const poId = (poNumber: string, total: number, orderOffset: number, expectedOffset: number) => {
    const row = db.prepare('SELECT id FROM purchase_orders WHERE client_id = ? AND po_number = ?').get(rfbClient.id, poNumber) as { id: number } | undefined;
    if (row) return row.id;
    return Number(
      db
        .prepare(`INSERT INTO purchase_orders (client_id, supplier_id, po_number, total, order_date, expected_date, status)
                  VALUES (?, ?, ?, ?, date('now', ?), date('now', ?), 'received')`)
        .run(rfbClient.id, supplierId, poNumber, total, `${orderOffset} days`, `${expectedOffset} days`).lastInsertRowid,
    );
  };
  const po101 = poId('PO-ABC-101', 145000, -20, -5);
  const po102 = poId('PO-ABC-102', 85000, -15, -2);

  const today = istDay(now);
  const ym = today.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const bills: [string, number | null, string, number, number][] = [
    ['BILL-ABC-201', po101, `${ym}-25`, 145000, 0], // due this month, unpaid
    ['BILL-ABC-202', po102, `${ym}-15`, 85000, 25000], // due this month, partly paid
    ['BILL-ABC-301', null, `${nextYm}-10`, 60000, 0], // due next month
  ];
  const insertBill = db.prepare(`
    INSERT INTO supplier_bills (client_id, bill_number, supplier_id, purchase_order_id, due_date, amount, paid_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [billNumber, poRef, due, amount, paid] of bills) {
    const has = db.prepare('SELECT 1 FROM supplier_bills WHERE client_id = ? AND bill_number = ?').get(rfbClient.id, billNumber);
    if (!has) insertBill.run(rfbClient.id, billNumber, supplierId, poRef, due, amount, paid, paid > 0 ? 'partially_paid' : 'open');
  }
}

type SeededAnswer = {
  responseId: string;
  companyId: string;
  tenantId: string;
  question: string;
  answer: string;
  department: string;
  sourceDocumentIds: string[];
};

const RFB = { companyId: 'company-rfb-latex', tenantId: 'tenant-rfb-latex' };
const ALP = { companyId: 'company-alpine-retail', tenantId: 'tenant-alpine-retail' };
const MFG = { companyId: 'company-demo-mfg', tenantId: 'tenant-demo-mfg' };

/**
 * Approved stored answers for the 21 demo questions. Every statement is taken from the cited demo document,
 * so an answer built from a stored response never contradicts or adds to the approved source.
 */
export const SEEDED_ANSWERS: SeededAnswer[] = [
  // --- RFB Latex ---
  {
    responseId: 'resp-rfb-001', ...RFB, department: 'Sales', sourceDocumentIds: ['doc-rfb-sales-001'],
    question: 'How do I create a Sales Order?',
    answer:
      "1. Go to Sales -> Orders -> Create Order in WhizUnik Hub.\n2. Select the customer account; the system fetches the credit limit, outstanding balance and pricing tier.\n3. Choose the SKU (LATEX-EXAM-100 or NITRILE-PF-200) and enter the box quantity, shipping address and delivery date.\n4. Save as 'Draft' to check line pricing and freight terms.\n5. If the order total exceeds the customer's available credit, it is locked as 'Credit Approval Required' until the Finance Manager or Checker approves it.\n6. Once approved, the order becomes 'Confirmed' and soft-reserves stock.",
  },
  {
    responseId: 'resp-rfb-002', ...RFB, department: 'Finance', sourceDocumentIds: ['doc-rfb-finance-001'],
    question: 'When is an invoice generated?',
    answer:
      'Customer tax invoices are generated automatically when the warehouse confirms dispatch and the Gate Pass and e-Way Bill are generated. An invoice cannot be generated before the stock is physically picked and packed.',
  },
  {
    responseId: 'resp-rfb-003', ...RFB, department: 'Finance', sourceDocumentIds: ['doc-rfb-finance-001'],
    question: 'How is GST shown on the invoice?',
    answer:
      'Intra-state supplies within Maharashtra show CGST 9% + SGST 9%; inter-state supplies show IGST 18%. The invoice header shows the customer GSTIN, the RFB Latex GSTIN (27AAACR1234F1Z8) and HSN code 4015 for medical examination gloves, and the invoice summary itemises the taxable value, the tax breakup by rate and the round-off adjustment.',
  },
  {
    responseId: 'resp-rfb-004', ...RFB, department: 'Finance', sourceDocumentIds: ['doc-rfb-finance-002'],
    question: 'How do we record a customer receipt?',
    answer:
      '1. Open Finance -> Receipts -> New Receipt in WhizUnik Hub.\n2. Select the paying customer and the payment mode (NEFT, RTGS, IMPS or Cheque).\n3. Enter the transaction reference / UTR number, the bank account credited and the receipt amount.\n4. Select the unpaid sales invoices to knock off against the payment.\n5. The receipt posts to the Accounts Receivable sub-ledger and the customer outstanding balance updates immediately.',
  },
  {
    responseId: 'resp-rfb-005', ...RFB, department: 'Returns', sourceDocumentIds: ['doc-rfb-returns-001'],
    question: 'What happens when goods are returned?',
    answer:
      'The customer logs a return request within 7 calendar days of delivery with the original invoice number and photos of the damage or discrepancy. The Returns Team validates the claim against dispatch records and issues an RMA ticket; goods without a valid RMA are not received at the gate. Returned cartons are scanned and routed to Quarantine Bay Q-2, where the QA Inspector checks them and classifies any damage as Transit Damage or Manufacturing Defect.',
  },
  {
    responseId: 'resp-rfb-006', ...RFB, department: 'Returns', sourceDocumentIds: ['doc-rfb-returns-001'],
    question: 'How are damaged returns treated?',
    answer:
      "Damaged medical gloves are never re-packed or returned to active inventory. QA changes the disposition to 'Quarantine Scrap' and posts a stock write-off to the Damaged Goods Ledger (account code 5040-DMG), and the scrap is scheduled for certified biomedical disposal. Finance issues a Tax Credit Note referencing the original Tax Invoice with reason code CR-DMG-01.",
  },
  {
    responseId: 'resp-rfb-007', ...RFB, department: 'Returns', sourceDocumentIds: ['doc-rfb-returns-001'],
    question: 'How do we handle a damaged customer return?',
    answer:
      "1. The customer logs a return request within 7 calendar days of delivery with the original invoice number and photos; the Returns Team validates it and issues an RMA.\n2. Returned cartons are scanned and routed to Quarantine Bay Q-2, where QA classifies the damage as Transit Damage or Manufacturing Defect.\n3. QA marks damaged gloves as 'Quarantine Scrap' and writes them off to 5040-DMG; they are never returned to stock.\n4. Finance issues a Tax Credit Note referencing the original Tax Invoice with reason code CR-DMG-01.\n5. Replacement: a zero-value Sales Order is generated and dispatched with priority. Refund: Finance releases the remittance within 3 business days of QA sign-off.",
  },
  {
    responseId: 'resp-rfb-008', ...RFB, department: 'Finance', sourceDocumentIds: ['doc-rfb-finance-003'],
    question: 'How is a credit note linked to the original invoice?',
    answer:
      "1. Go to Finance -> Credit Notes -> Create Credit Note.\n2. Search for and select the original Tax Invoice number in the 'Original Invoice Ref' field.\n3. The system pulls the original GST rates, HSN codes and unit prices to prevent a tax mismatch.\n4. Select the reason code (CR-DMG-01 for damaged goods or CR-RET-01 for commercial returns).\n5. On approval, the credit note is linked to the invoice ledger and adjusts the net receivable.",
  },
  {
    responseId: 'resp-rfb-009', ...RFB, department: 'Tally', sourceDocumentIds: ['doc-rfb-tally-001'],
    question: 'How does the Tally connector work?',
    answer:
      "WhizUnik connects to TallyPrime via XML over local/network port 9000 using Tally's XML Server gateway. An automated sync job runs hourly and queues approved Sales Invoices, Customer Receipts, Credit Notes and Purchase Vouchers. When Tally acknowledges a record, its status changes to 'Synced' and the Tally Master ID and Voucher GUID are stored. Failed items go to the Tally Exception Queue for audit review and manual re-post.",
  },
  {
    responseId: 'resp-rfb-010', ...RFB, department: 'Inventory', sourceDocumentIds: ['doc-rfb-inv-001'],
    question: 'When is stock deducted?',
    answer:
      "Stock is soft-reserved when the Sales Order is confirmed, to prevent double booking. It is physically deducted from main inventory only when Security marks the Gate Pass as 'Dispatched' at the warehouse exit gate. Packing and staging do not deduct stock from the inventory ledger.",
  },
  {
    responseId: 'resp-rfb-011', ...RFB, department: 'Procurement', sourceDocumentIds: ['doc-rfb-proc-001'],
    question: 'How do we record a supplier payment?',
    answer:
      '1. Go to Finance -> Accounts Payable -> Supplier Payments.\n2. Select the vendor and verify the approved 3-way matched Purchase Orders and inward GRN invoices.\n3. Apply TDS under Section 194Q or 194C as applicable.\n4. Submit the payment voucher for dual approval (Procurement Head and Finance Director).\n5. Once approved, generate the bank payout file for NEFT/RTGS.',
  },

  // --- Alpine Retail ---
  {
    responseId: 'resp-alp-001', ...ALP, department: 'Marketplace', sourceDocumentIds: ['doc-alp-mkt-001'],
    question: 'How do we process a marketplace order?',
    answer:
      "1. Orders from Amazon, Flipkart and Shopify sync into WhizUnik every 5 minutes and arrive as 'Unfulfilled', immediately locking available inventory.\n2. The Fulfillment Centre creates picking batches and prints marketplace-compliant shipping labels with tracking barcodes.\n3. Packed parcels are scanned into manifest bays.\n4. When the courier partner (Delhivery, BlueDart or ATS) scans the handover, WhizUnik pushes the tracking number and 'Shipped' status back to the marketplace.",
  },
  {
    responseId: 'resp-alp-002', ...ALP, department: 'Inventory', sourceDocumentIds: ['doc-alp-inv-001'],
    question: 'How is stock reserved?',
    answer:
      "When an order is placed on any online channel, the Available-to-Promise (ATP) pool decreases immediately by the order quantity. The reserved stock is held in the 'Marketplace Reserve Buffer' for a maximum of 24 hours pending shipment. If the customer cancels or courier pickup fails, the stock is released back to the ATP pool automatically.",
  },
  {
    responseId: 'resp-alp-003', ...ALP, department: 'Inventory', sourceDocumentIds: ['doc-alp-inv-001'],
    question: 'How is stock reserved for a marketplace order?',
    answer:
      "When a marketplace order is placed, the Available-to-Promise (ATP) pool decreases immediately by the order quantity, and the stock is held in the 'Marketplace Reserve Buffer' for a maximum of 24 hours pending shipment. If the order is cancelled or courier pickup fails, the stock is released back to the ATP pool automatically.",
  },
  {
    responseId: 'resp-alp-004', ...ALP, department: 'Returns', sourceDocumentIds: ['doc-alp-returns-001'],
    question: 'How are marketplace returns handled?',
    answer:
      'Returns are identified by airway bill (AWB) or marketplace return barcode and classified as RTO (Return to Origin, unopened) or Customer Return (open box). The QC team verifies the barcode and inspects the item: Grade A (unopened/pristine) is sanitised and returned to marketplace inventory; Grade B (damaged packaging) goes to the discount liquidation channel; damaged, counterfeit or wrong items are photographed, logged for a marketplace dispute claim and marked as scrap.',
  },
  {
    responseId: 'resp-alp-005', ...ALP, department: 'Finance', sourceDocumentIds: ['doc-alp-fin-001'],
    question: 'How is a refund recorded?',
    answer:
      'Marketplace gateway refunds are imported into WhizUnik weekly from the marketplace settlement remittance files. Finance runs the automated reconciliation, matching the Marketplace Order ID against gateway processing fees, commission deductions and net customer refunds. Approved refunds post a debit entry to the Marketplace Escrow Clearing Account and adjust net channel sales.',
  },
  {
    responseId: 'resp-alp-006', ...ALP, department: 'Finance', sourceDocumentIds: ['doc-alp-fin-002'],
    question: 'How is a credit note created?',
    answer:
      '1. Open Finance -> Invoicing -> Marketplace Credit Notes.\n2. Enter the original B2C Tax Invoice number or the Marketplace Order ID.\n3. The system calculates the GST reversal and generates an e-Credit Note.\n4. The credit note reference is pushed to the marketplace settlement report for reconciliation.',
  },

  // --- Demo Manufacturing Co. ---
  {
    responseId: 'resp-mfg-001', ...MFG, department: 'Procurement', sourceDocumentIds: ['doc-mfg-proc-001'],
    question: 'How do we purchase raw material?',
    answer:
      '1. Material Requirement Planning (MRP) runs weekly from active sales orders and production schedules and generates purchase requisitions for steel, polymers and fasteners.\n2. The Procurement Officer issues a Request for Quotation (RFQ) to at least 3 approved vendors.\n3. A commercial comparative statement is prepared; the Purchase Order is created in WhizUnik and submitted to the Plant Head for approval.\n4. Once signed, the PO is sent through the vendor portal with delivery dates and penalty terms for delays.',
  },
  {
    responseId: 'resp-mfg-002', ...MFG, department: 'Warehouse', sourceDocumentIds: ['doc-mfg-wh-001'],
    question: 'How is a GRN created?',
    answer:
      '1. The delivery vehicle reports to the unloading gate with the supplier delivery challan and invoice; Security enters the vehicle number in the Inward Gate Register.\n2. The Warehouse Supervisor opens Procurement -> GRN -> Create GRN in WhizUnik.\n3. Select the Purchase Order and enter received quantities, heat/batch certificates and heat treatment numbers.\n4. The system flags the consignment for QA sampling inspection.\n5. Once QA logs chemical and dimensional approval, the GRN is finalised and raw material stock is updated in the warehouse ledger.',
  },
  {
    responseId: 'resp-mfg-003', ...MFG, department: 'Warehouse', sourceDocumentIds: ['doc-mfg-prod-001'],
    question: 'How is material issued for production?',
    answer:
      '1. The Production Supervisor raises a Material Issue Request (MIR) citing the active Work Order number.\n2. The warehouse checks the MIR against the standard Bill of Materials (BOM).\n3. Raw materials are picked, scanned and transferred to the Shop Floor Staging Bay.\n4. The warehouse confirms the issue in WhizUnik, which decreases raw material stock and increases Work-In-Progress (WIP) inventory.',
  },
  {
    responseId: 'resp-mfg-004', ...MFG, department: 'Warehouse', sourceDocumentIds: ['doc-mfg-prod-002'],
    question: 'How is finished goods stock updated?',
    answer:
      '1. After assembly and final QC testing, the Quality Engineer stamps the inspection certificate.\n2. The Production Supervisor closes the Work Order and issues a Finished Goods Transfer Note (FGTN).\n3. The warehouse scans serial numbers at the Finished Goods Bay.\n4. The system increases the Finished Goods inventory balance and decreases the Work-In-Progress (WIP) ledger.',
  },
  {
    responseId: 'resp-mfg-005', ...MFG, department: 'Warehouse', sourceDocumentIds: ['doc-mfg-wh-002'],
    question: 'How do we track warehouse movement?',
    answer:
      'Every transfer between racks, staging bins and quarantine is scanned with a Handheld Terminal (HHT): the operator scans the source bin barcode, the item serial/lot barcode and the destination bin barcode. WhizUnik updates the warehouse map in real time and records the operator ID and timestamp in the Warehouse Transfer Ledger.',
  },
];

/**
 * Insert missing demo answers and refresh the wording of existing ones (matched by their fixed response id and
 * created by the seed). Answers added by Knowledge Admins are never touched.
 */
export function syncSeededAnswers(db: Db, knowledgeService: RagKnowledgeService) {
  const update = db.prepare(`
    UPDATE rag_stored_responses
    SET question = ?, answer = ?, department = ?, source_document_ids = ?, updated_at = ?
    WHERE response_id = ? AND company_id = ? AND created_by = 'admin'
  `);
  const now = new Date().toISOString();
  for (const qa of SEEDED_ANSWERS) {
    const byId = db.prepare('SELECT response_id FROM rag_stored_responses WHERE response_id = ?').get(qa.responseId);
    if (byId) {
      update.run(qa.question, qa.answer, qa.department, JSON.stringify(qa.sourceDocumentIds), now, qa.responseId, qa.companyId);
      continue;
    }
    const sameQuestion = db.prepare('SELECT response_id FROM rag_stored_responses WHERE company_id = ? AND question = ?').get(qa.companyId, qa.question);
    if (sameQuestion) continue;
    knowledgeService.createQa({
      responseId: qa.responseId,
      tenantId: qa.tenantId,
      companyId: qa.companyId,
      question: qa.question,
      answer: qa.answer,
      department: qa.department as RagDepartment,
      sourceDocumentIds: qa.sourceDocumentIds,
      createdBy: 'admin',
      approvedStatus: 'approved',
    });
  }
}

/**
 * Called at startup in demo mode for an existing database: refreshes the demo answers and live demo data
 * so fixes to the demo content reach databases created by an older version.
 */
export function refreshRagDemoContent(db: Db, config: AppConfig) {
  const hasRag = db.prepare("SELECT 1 FROM rag_companies WHERE company_id = 'company-rfb-latex'").get();
  if (!hasRag) return;
  const knowledgeService = new RagKnowledgeService(db, new RagVectorService(config));
  db.transaction(() => {
    ensureSupplierDemoData(db);
    syncSeededAnswers(db, knowledgeService);
  })();
}
