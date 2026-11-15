import bcrypt from 'bcryptjs';
import type { Db } from '../types';
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

  // Ensure suppliers exist for balance queries (e.g. ABC Raw Materials)
  const rfbClient = db.prepare("SELECT id FROM clients WHERE company_id = 'company-rfb-latex'").get() as { id: number };
  if (rfbClient) {
    const abcSupplier = db.prepare("SELECT id FROM suppliers WHERE client_id = ? AND name = 'ABC Raw Materials'").get(rfbClient.id) as { id: number } | undefined;
    let supplierId = abcSupplier?.id;
    if (!supplierId) {
      const res = db.prepare(`
        INSERT INTO suppliers (client_id, name, lead_time_days, contact_email)
        VALUES (?, 'ABC Raw Materials', 7, 'ap@abcrawmaterials.example')
      `).run(rfbClient.id);
      supplierId = Number(res.lastInsertRowid);
    }
    // Seed open purchase orders / invoices for ABC Raw Materials
    const poExists = db.prepare("SELECT id FROM purchase_orders WHERE client_id = ? AND po_number = 'PO-ABC-101'").get(rfbClient.id);
    if (!poExists) {
      db.prepare(`
        INSERT INTO purchase_orders (client_id, supplier_id, po_number, total, order_date, expected_date, status)
        VALUES (?, ?, 'PO-ABC-101', 145000, date('now', '-5 days'), date('now', '+10 days'), 'approved')
      `).run(rfbClient.id, supplierId);
      db.prepare(`
        INSERT INTO purchase_orders (client_id, supplier_id, po_number, total, order_date, expected_date, status)
        VALUES (?, ?, 'PO-ABC-102', 85000, date('now', '-2 days'), date('now', '+18 days'), 'approved')
      `).run(rfbClient.id, supplierId);
    }
  }

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

  // 6. Seed Stored Approved Responses (Q&A) per PDF page 3
  const storedQa = [
    {
      responseId: 'resp-rfb-001',
      companyId: 'company-rfb-latex',
      tenantId: 'tenant-rfb-latex',
      question: 'How do we record a customer receipt?',
      answer: 'Open Finance, select Receipts, choose the customer invoice, enter the payment reference/UTR and amount received, then submit to reconcile with bank accounts.',
      department: 'Finance',
      sourceDocumentIds: ['doc-rfb-finance-002'],
    },
    {
      responseId: 'resp-rfb-002',
      companyId: 'company-rfb-latex',
      tenantId: 'tenant-rfb-latex',
      question: 'How do we handle a damaged customer return?',
      answer: 'Customer returns must be logged within 7 days with photos to get an RMA. On warehouse receipt, QA inspects goods in Quarantine Bay Q-2, marks disposition as Quarantine Scrap, Finance issues a Credit Note CR-DMG-01 linked to original invoice, and dispatches replacement or issues refund.',
      department: 'Returns',
      sourceDocumentIds: ['doc-rfb-returns-001'],
    },
    {
      responseId: 'resp-alp-001',
      companyId: 'company-alpine-retail',
      tenantId: 'tenant-alpine-retail',
      question: 'How is stock reserved for a marketplace order?',
      answer: 'When a marketplace order is ingested, the Available-to-Promise (ATP) pool decreases immediately by the order quantity. The stock is held in the reserve buffer for up to 24 hours pending shipment.',
      department: 'Inventory',
      sourceDocumentIds: ['doc-alp-inv-001'],
    },
    {
      responseId: 'resp-mfg-001',
      companyId: 'company-demo-mfg',
      tenantId: 'tenant-demo-mfg',
      question: 'How is a GRN created?',
      answer: 'When materials arrive, security logs the vehicle in the Inward Register. The warehouse supervisor opens Procurement -> GRN -> Create GRN, selects the PO number, enters received quantities and batch certificates, and finalizes GRN following QA sampling sign-off.',
      department: 'Warehouse',
      sourceDocumentIds: ['doc-mfg-wh-001'],
    },
  ];

  for (const qa of storedQa) {
    const exists = db.prepare('SELECT response_id FROM rag_stored_responses WHERE company_id = ? AND question = ?').get(qa.companyId, qa.question);
    if (!exists) {
      knowledgeService.createQa({
        responseId: qa.responseId,
        tenantId: qa.tenantId,
        companyId: qa.companyId,
        question: qa.question,
        answer: qa.answer,
        department: qa.department as any,
        sourceDocumentIds: qa.sourceDocumentIds,
        createdBy: 'admin',
        approvedStatus: 'approved',
      });
    }
  }
}
