import crypto from 'node:crypto';
import { AppError } from '../errors';
import type { Db, RagApprovedStatus, RagDepartment, RagSourceType } from '../types';
import type { RagVectorService } from './rag-vector.service';

const ALLOWED_TRANSITIONS: Partial<Record<RagApprovedStatus, RagApprovedStatus[]>> = {
  approved: ['pending_review'],
  rejected: ['pending_review'],
  archived: ['approved'],
};

export interface CreateDocumentInput {
  documentId?: string;
  tenantId: string;
  companyId: string;
  title: string;
  description?: string;
  department: RagDepartment;
  content: string;
  sourceType?: RagSourceType;
  createdBy: string;
  approvedStatus?: RagApprovedStatus;
}

export interface CreateQaInput {
  responseId?: string;
  tenantId: string;
  companyId: string;
  question: string;
  answer: string;
  department: RagDepartment;
  sourceDocumentIds?: string[];
  createdBy: string;
  approvedStatus?: 'approved' | 'pending' | 'rejected';
}

export class RagKnowledgeService {
  private db: Db;
  private vectorService: RagVectorService;

  constructor(db: Db, vectorService: RagVectorService) {
    this.db = db;
    this.vectorService = vectorService;
  }

  /**
   * List company documents
   */
  listDocuments(companyId: string, opts: { department?: string; status?: string } = {}) {
    let sql = `
      SELECT document_id, tenant_id, company_id, title, description, department,
             source_type, approved_status, version, created_by, approved_by,
             approved_at, created_at, updated_at
      FROM rag_documents
      WHERE company_id = ? AND is_deleted = 0
    `;
    const params: any[] = [companyId];

    if (opts.department && opts.department !== 'all') {
      sql += ' AND department = ?';
      params.push(opts.department);
    }
    if (opts.status && opts.status !== 'all') {
      sql += ' AND approved_status = ?';
      params.push(opts.status);
    }
    sql += ' ORDER BY created_at DESC';

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get document by ID with chunks
   */
  getDocument(documentId: string, companyId: string) {
    const doc = this.db
      .prepare(`
        SELECT * FROM rag_documents
        WHERE document_id = ? AND company_id = ? AND is_deleted = 0
      `)
      .get(documentId, companyId);

    if (!doc) return null;

    const chunks = this.db
      .prepare(`
        SELECT chunk_id, chunk_index, section_heading, text, token_estimate, approved_status
        FROM rag_chunks
        WHERE document_id = ? AND company_id = ? AND is_deleted = 0
        ORDER BY chunk_index ASC
      `)
      .all(documentId, companyId);

    return { ...doc, chunks };
  }

  /**
   * Create and index a new knowledge document
   */
  createDocument(input: CreateDocumentInput) {
    const documentId = input.documentId || `doc-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    // Spec §7: an upload is not usable for answers until a Knowledge Admin approves it.
    const approvedStatus = input.approvedStatus || 'pending_review';

    this.db
      .prepare(`
        INSERT INTO rag_documents (
          document_id, tenant_id, company_id, title, description,
          department, content, source_type, approved_status, version,
          visibility, is_deleted, created_by, approved_by, approved_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'company', 0, ?, ?, ?, ?, ?)
      `)
      .run(
        documentId,
        input.tenantId,
        input.companyId,
        input.title,
        input.description || null,
        input.department,
        input.content,
        input.sourceType || 'workflow',
        approvedStatus,
        input.createdBy,
        approvedStatus === 'approved' ? input.createdBy : null,
        approvedStatus === 'approved' ? now : null,
        now,
        now,
      );

    // Chunk and embed document
    const chunks = this.vectorService.chunkDocument({
      documentId,
      tenantId: input.tenantId,
      companyId: input.companyId,
      title: input.title,
      department: input.department,
      content: input.content,
    });

    const insertChunk = this.db.prepare(`
      INSERT INTO rag_chunks (
        chunk_id, document_id, tenant_id, company_id, chunk_index,
        section_heading, text, token_estimate, embedding, approved_status,
        is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    for (const chk of chunks) {
      insertChunk.run(
        chk.chunkId,
        chk.documentId,
        chk.tenantId,
        chk.companyId,
        chk.chunkIndex,
        chk.sectionHeading,
        chk.text,
        chk.tokenEstimate,
        JSON.stringify(chk.embedding),
        approvedStatus,
        now,
      );
    }

    return { documentId, chunksCount: chunks.length };
  }

  /**
   * Update document approval status (approve / reject / archive)
   */
  updateDocumentStatus(documentId: string, companyId: string, status: RagApprovedStatus, user: string) {
    const doc = this.db
      .prepare('SELECT approved_status FROM rag_documents WHERE document_id = ? AND company_id = ? AND is_deleted = 0')
      .get(documentId, companyId) as { approved_status: RagApprovedStatus } | undefined;
    if (!doc) throw new AppError('NOT_FOUND', 404, 'Document not found.');

    // Lifecycle (spec §7): pending_review → approved | rejected; approved → archived.
    const allowedFrom = ALLOWED_TRANSITIONS[status] ?? [];
    if (!allowedFrom.includes(doc.approved_status)) {
      throw new AppError('CONFLICT', 409, `A document that is ${doc.approved_status.replace('_', ' ')} cannot be ${status}.`);
    }

    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      // approved_by / approved_at record the approver only; other decisions just update the timestamp.
      if (status === 'approved') {
        this.db
          .prepare('UPDATE rag_documents SET approved_status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE document_id = ? AND company_id = ?')
          .run(status, user, now, now, documentId, companyId);
      } else {
        this.db
          .prepare('UPDATE rag_documents SET approved_status = ?, updated_at = ? WHERE document_id = ? AND company_id = ?')
          .run(status, now, documentId, companyId);
      }
      // Cascade status to the document's chunks (same company only).
      this.db.prepare('UPDATE rag_chunks SET approved_status = ? WHERE document_id = ? AND company_id = ?').run(status, documentId, companyId);
    });
    run();

    return { success: true, documentId, status };
  }

  /**
   * Add manual approved Q&A
   */
  createQa(input: CreateQaInput) {
    const responseId = input.responseId || `resp-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO rag_stored_responses (
          response_id, tenant_id, company_id, question, answer, department,
          source_document_ids, approved_status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        responseId,
        input.tenantId,
        input.companyId,
        input.question,
        input.answer,
        input.department,
        JSON.stringify(input.sourceDocumentIds || []),
        input.approvedStatus || 'approved',
        input.createdBy,
        now,
        now,
      );

    return { responseId };
  }

  /**
   * List approved stored Q&A for company
   */
  listQa(companyId: string) {
    return this.db
      .prepare(`
        SELECT response_id, tenant_id, company_id, question, answer, department,
               source_document_ids, approved_status, created_by, created_at
        FROM rag_stored_responses
        WHERE company_id = ?
        ORDER BY created_at DESC
      `)
      .all(companyId);
  }
}
