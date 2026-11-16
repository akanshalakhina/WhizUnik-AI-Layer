import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openReadOnlyDb, openWritableDb } from '../src/db/database';
import { seedDemoData } from '../src/db/seed';
import { RagGenerationService } from '../src/services/rag-generation.service';

const PASSWORD = 'Test@12345';

function createTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whizunik-rag-test-'));
  const file = path.join(dir, 'test.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: file,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
    AI_PROVIDER: 'local',
  });
  const db = openWritableDb(file);
  seedDemoData(db, { password: PASSWORD, bcryptRounds: 4 });
  const roDb = openReadOnlyDb(file);
  const { app } = createApp({ config, db, roDb });

  const login = async (email: string) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
    return res.body.token as string;
  };

  return {
    app,
    db,
    config,
    login,
    cleanup: () => {
      try {
        db.close();
        roDb.close();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe('WhizUnik AI RAG Application — Specification Acceptance Tests', () => {
  it('1. RFB Latex user retrieves only RFB Latex approved data for damaged returns', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('returns@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How do we handle a damaged customer return?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('grounded');
      expect(res.body.citations.length).toBeGreaterThan(0);
      expect(res.body.citations[0].documentId).toBe('doc-rfb-returns-001');
      expect(res.body.answer).toContain('Quarantine Bay Q-2');
      expect(res.body.answer).toContain('Credit Note');
    } finally {
      env.cleanup();
    }
  });

  it('2. Alpine Retail user retrieves only Alpine Retail marketplace workflow', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('marketplace@alpineretail.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How is stock reserved for a marketplace order?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('grounded');
      expect(res.body.citations.length).toBeGreaterThan(0);
      expect(res.body.citations[0].documentId).toBe('doc-alp-inv-001');
      expect(res.body.answer).toContain('Available-to-Promise');
    } finally {
      env.cleanup();
    }
  });

  it('3. Demo Manufacturing user retrieves only Demo Manufacturing GRN SOP', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('warehouse@demomfg.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How is a GRN created?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('grounded');
      expect(res.body.citations.length).toBeGreaterThan(0);
      expect(res.body.citations[0].documentId).toBe('doc-mfg-wh-001');
      // Wording comes from the approved SOP ("Inward Gate Register"), not invented detail.
      expect(res.body.answer).toContain('Inward Gate Register');
    } finally {
      env.cleanup();
    }
  });

  it('4. Cross-tenant isolation: Alpine user asking for RFB Latex damaged return cannot retrieve RFB data', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('marketplace@alpineretail.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How are medical glove damaged returns treated in Quarantine Bay Q-2?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('insufficient_evidence');
      expect(res.body.answer).toBe(RagGenerationService.UNAVAILABLE_MSG);
      expect(res.body.citations.length).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('5. Sentinel phrase isolation: Company A user querying Company B sentinel phrase returns unavailable', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('admin@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'What is the secret in SENTINEL-ALPINE-RETAIL-SECRET-2026?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('insufficient_evidence');
      expect(res.body.answer).toBe(RagGenerationService.UNAVAILABLE_MSG);
      expect(res.body.citations.length).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('6. Frontend cannot override companyId: derived strictly from token', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('marketplace@alpineretail.demo');
      // Attempting to send companyId or clientId spoof in body
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({
          question: 'How are medical glove damaged returns treated in Quarantine Bay Q-2?',
          companyId: 'company-rfb-latex',
          clientId: 3,
        });

      expect(res.status).toBe(200);
      // Because authenticated token is Alpine Retail, it evaluates ONLY within Alpine Retail's company
      expect(res.body.answerStatus).toBe('insufficient_evidence');
      expect(res.body.answer).toBe(RagGenerationService.UNAVAILABLE_MSG);
    } finally {
      env.cleanup();
    }
  });

  it('7. Unapproved documents are never retrieved', async () => {
    const env = createTestEnv();
    try {
      // Create a pending review document for RFB Latex
      env.db
        .prepare(`
          INSERT INTO rag_documents (
            document_id, tenant_id, company_id, title, department,
            content, approved_status, version, created_by, created_at, updated_at
          ) VALUES (
            'doc-unapproved-01', 'tenant-rfb-latex', 'company-rfb-latex',
            'Unapproved Protocol', 'Finance', 'Confidential unapproved payment backdoor protocol',
            'pending_review', 1, 'hacker', datetime('now'), datetime('now')
          )
        `)
        .run();

      env.db
        .prepare(`
          INSERT INTO rag_chunks (
            chunk_id, document_id, tenant_id, company_id, chunk_index,
            text, approved_status, is_deleted, created_at
          ) VALUES (
            'chk-unapproved-01', 'doc-unapproved-01', 'tenant-rfb-latex', 'company-rfb-latex', 0,
            'Confidential unapproved payment backdoor protocol', 'pending_review', 0, datetime('now')
          )
        `)
        .run();

      const token = await env.login('admin@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'What is the unapproved payment backdoor protocol?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('insufficient_evidence');
      expect(res.body.answer).not.toContain('backdoor');
    } finally {
      env.cleanup();
    }
  });

  it('8. Deleted documents are never retrieved', async () => {
    const env = createTestEnv();
    try {
      // Soft-delete the Sales Order document
      env.db
        .prepare("UPDATE rag_documents SET is_deleted = 1 WHERE document_id = 'doc-rfb-sales-001'")
        .run();
      env.db
        .prepare("UPDATE rag_chunks SET is_deleted = 1 WHERE document_id = 'doc-rfb-sales-001'")
        .run();

      const token = await env.login('sales@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How do I create a Sales Order?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('insufficient_evidence');
      expect(res.body.answer).toBe(RagGenerationService.UNAVAILABLE_MSG);
    } finally {
      env.cleanup();
    }
  });

  it('9. Live business data query: supplier outstanding balance', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('finance@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How much do we owe ABC Raw Materials for invoices due this month?' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('grounded');
      expect(res.body.answer).toContain('ABC Raw Materials');
      expect(res.body.intent).toBe('supplier_balance');
      // Amount owed = unpaid supplier bills due this month (not purchase-order totals):
      // BILL-ABC-201 ₹1,45,000 unpaid + BILL-ABC-202 ₹85,000 − ₹25,000 paid = ₹2,05,000. BILL-ABC-301 is due next month.
      expect(res.body.answer).toContain('BILL-ABC-201');
      expect(res.body.answer).toContain('BILL-ABC-202');
      expect(res.body.answer).not.toMatch(/BILL-ABC-301 —/);
      expect(res.body.answer).toContain('2,05,000');
      expect(res.body.answer).not.toContain('PO-ABC-101');
      expect(res.body.citations[0].documentId).toBe('live-finance-ap');
    } finally {
      env.cleanup();
    }
  });

  it('10. Ambiguous questions trigger targeted clarification', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('admin@rfblatex.demo');
      const res = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'cancel' });

      expect(res.status).toBe(200);
      expect(res.body.answerStatus).toBe('clarification_needed');
      expect(res.body.clarificationQuestion).toBeTruthy();
    } finally {
      env.cleanup();
    }
  });

  it('11. Feedback and proposed corrections lifecycle', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('returns@rfblatex.demo');
      const askRes = await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How do we handle a damaged customer return?' });

      const messageId = askRes.body.messageId;

      const fbRes = await request(env.app)
        .post('/api/v1/assistant/feedback')
        .set('Authorization', `Bearer ${token}`)
        .send({
          messageId,
          feedback: 'not_helpful',
          comment: 'We recently moved to Quarantine Bay Q-3 instead of Q-2.',
          proposedCorrection: 'Damaged returns now go to Quarantine Bay Q-3.',
        });

      expect(fbRes.status).toBe(200);
      expect(fbRes.body.success).toBe(true);
      expect(fbRes.body.reviewStatus).toBe('pending');

      // The review queue is for Knowledge Admins only.
      const denied = await request(env.app).get('/api/v1/admin/feedback-reviews').set('Authorization', `Bearer ${token}`);
      expect(denied.status).toBe(403);

      const adminToken = await env.login('admin@rfblatex.demo');
      const revRes = await request(env.app)
        .get('/api/v1/admin/feedback-reviews')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(revRes.status).toBe(200);
      expect(revRes.body.reviews.length).toBeGreaterThan(0);
      expect(revRes.body.reviews[0].proposed_correction).toContain('Q-3');
    } finally {
      env.cleanup();
    }
  });

  it('12. Knowledge base document lifecycle: upload, approve, archive', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('admin@rfblatex.demo');

      // Create document
      const createRes = await request(env.app)
        .post('/api/v1/knowledge/documents')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Special Packaging Guidelines 2026',
          department: 'Warehouse',
          content: 'Medical gloves for international export must use hermetically sealed double-layer poly packs.',
          sourceType: 'sop',
        });

      expect(createRes.status).toBe(201);
      const docId = createRes.body.documentId;
      const ask = (t: string) =>
        request(env.app).post('/api/v1/assistant/ask').set('Authorization', `Bearer ${t}`).send({ question: 'How must medical gloves for international export be packed?' });
      const cites = (r: request.Response) => (r.body.citations ?? []).map((c: { documentId: string }) => c.documentId);

      // A new upload waits for review and is NOT used for answers.
      const detail = await request(env.app).get(`/api/v1/knowledge/documents/${docId}`).set('Authorization', `Bearer ${token}`);
      expect(detail.body.document.approved_status).toBe('pending_review');
      expect(cites(await ask(token))).not.toContain(docId);

      // A pending document cannot be archived; it must be approved or rejected first.
      const early = await request(env.app).post(`/api/v1/knowledge/documents/${docId}/archive`).set('Authorization', `Bearer ${token}`);
      expect(early.status).toBe(409);

      const appr = await request(env.app).post(`/api/v1/knowledge/documents/${docId}/approve`).set('Authorization', `Bearer ${token}`);
      expect(appr.status).toBe(200);
      expect(cites(await ask(token))).toContain(docId);

      // Archive document
      const archRes = await request(env.app)
        .post(`/api/v1/knowledge/documents/${docId}/archive`)
        .set('Authorization', `Bearer ${token}`);

      expect(archRes.status).toBe(200);
      expect(archRes.body.status).toBe('archived');
      expect(cites(await ask(token))).not.toContain(docId);

      // Unknown document → 404, not 500.
      const missing = await request(env.app).post('/api/v1/knowledge/documents/doc-nope/approve').set('Authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
    } finally {
      env.cleanup();
    }
  });

  it('13. Audit events logging records tokens, latency and source IDs', async () => {
    const env = createTestEnv();
    try {
      const token = await env.login('admin@rfblatex.demo');
      await request(env.app)
        .post('/api/v1/assistant/ask')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'When is an invoice generated?' });

      const auditRes = await request(env.app)
        .get('/api/v1/admin/audit-events')
        .set('Authorization', `Bearer ${token}`);

      expect(auditRes.status).toBe(200);
      expect(auditRes.body.events.length).toBeGreaterThan(0);
      const ev = auditRes.body.events[0];
      expect(ev.question).toContain('invoice');
      expect(ev.answer_status).toBe('grounded');
      expect(JSON.parse(ev.retrieved_source_ids).length).toBeGreaterThan(0);
      expect(ev.latency_ms).toBeGreaterThanOrEqual(0);
      // No model was called (local provider), so the audit must not claim token usage.
      expect(ev.model).toContain('offline');
      expect(ev.tokens_total).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});
