import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { AppError } from '../errors';
import { authenticate } from '../middleware';
import type { Db } from '../types';
import { RagAssistantService } from '../services/rag-assistant.service';
import { RagKnowledgeService } from '../services/rag-knowledge.service';
import { RagVectorService } from '../services/rag-vector.service';

const AskBody = z.object({
  question: z.string().trim().min(1).max(1000),
  conversationId: z.string().trim().optional().nullable(),
  department: z.string().trim().optional().nullable(),
});

const FeedbackBody = z.object({
  messageId: z.string().trim().min(1),
  feedback: z.enum(['helpful', 'not_helpful']),
  comment: z.string().trim().max(1000).optional().nullable(),
  proposedCorrection: z.string().trim().max(2000).optional().nullable(),
});

const ClarifyBody = z.object({
  conversationId: z.string().trim().min(1),
  clarification: z.string().trim().min(1).max(1000),
  originalQuestion: z.string().trim().max(1000).optional().nullable(),
});

const CreateDocBody = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(500).optional().nullable(),
  department: z.string().trim().min(2).max(100),
  content: z.string().trim().min(10),
  sourceType: z.enum(['workflow', 'sop', 'policy', 'manual_qa', 'platform_doc']).optional(),
});

const CreateQaBody = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(5).max(3000),
  department: z.string().trim().min(2).max(100),
  sourceDocumentIds: z.array(z.string()).optional(),
});

export function createRagRouter(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const vectorService = new RagVectorService(cfg);
  const ragAssistant = new RagAssistantService(cfg, db);
  const ragKnowledge = new RagKnowledgeService(db, vectorService);

  const auth = authenticate(cfg, db);

  // ------------------------------------------------------------- 1. Assistant Endpoints
  /**
   * POST /api/v1/assistant/ask
   * The server derives companyId and tenantId from the authenticated identity.
   */
  router.post('/assistant/ask', auth, async (req, res, next) => {
    try {
      const body = AskBody.parse(req.body);
      const user = req.user!;
      const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;

      const result = await ragAssistant.ask(user, {
        question: body.question,
        conversationId: body.conversationId,
        departmentHint: body.department || undefined,
      });

      res.json({
        ...result,
        requestId,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/v1/assistant/conversations
   */
  router.get('/assistant/conversations', auth, (req, res, next) => {
    try {
      const list = ragAssistant.getConversations(req.user!.id);
      res.json({ conversations: list });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/v1/assistant/conversations/:id
   */
  router.get('/assistant/conversations/:id', auth, (req, res, next) => {
    try {
      const messages = ragAssistant.getConversationMessages(req.params.id, req.user!.id);
      res.json({ conversationId: req.params.id, messages });
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/assistant/feedback
   */
  router.post('/assistant/feedback', auth, (req, res, next) => {
    try {
      const body = FeedbackBody.parse(req.body);
      const result = ragAssistant.submitFeedback({
        messageId: body.messageId,
        userId: req.user!.id,
        feedback: body.feedback,
        comment: body.comment || undefined,
        proposedCorrection: body.proposedCorrection || undefined,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/assistant/clarify
   */
  router.post('/assistant/clarify', auth, async (req, res, next) => {
    try {
      const body = ClarifyBody.parse(req.body);
      const combined = body.originalQuestion
        ? `${body.originalQuestion} (Clarification: ${body.clarification})`
        : body.clarification;

      const result = await ragAssistant.ask(req.user!, {
        question: combined,
        conversationId: body.conversationId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------- 2. Knowledge Base Endpoints
  /**
   * GET /api/v1/knowledge/documents
   */
  router.get('/knowledge/documents', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const dept = typeof req.query.department === 'string' ? req.query.department : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const docs = ragKnowledge.listDocuments(companyId, { department: dept, status });
      res.json({ documents: docs });
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/knowledge/documents
   */
  router.post('/knowledge/documents', auth, (req, res, next) => {
    try {
      const body = CreateDocBody.parse(req.body);
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const tenantId = req.user!.tenantId || `tenant-${req.user!.clientId}`;

      const result = ragKnowledge.createDocument({
        tenantId,
        companyId,
        title: body.title,
        description: body.description || undefined,
        department: body.department as any,
        content: body.content,
        sourceType: body.sourceType,
        createdBy: req.user!.name,
      });

      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/v1/knowledge/documents/:id
   */
  router.get('/knowledge/documents/:id', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const doc = ragKnowledge.getDocument(req.params.id, companyId);
      if (!doc) throw new AppError('NOT_FOUND', 404, 'Document not found.');
      res.json({ document: doc });
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/knowledge/documents/:id/approve
   */
  router.post('/knowledge/documents/:id/approve', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const result = ragKnowledge.updateDocumentStatus(req.params.id, companyId, 'approved', req.user!.name);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/knowledge/documents/:id/reject
   */
  router.post('/knowledge/documents/:id/reject', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const result = ragKnowledge.updateDocumentStatus(req.params.id, companyId, 'rejected', req.user!.name);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/knowledge/documents/:id/archive
   */
  router.post('/knowledge/documents/:id/archive', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const result = ragKnowledge.updateDocumentStatus(req.params.id, companyId, 'archived', req.user!.name);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/v1/knowledge/qa
   */
  router.post('/knowledge/qa', auth, (req, res, next) => {
    try {
      const body = CreateQaBody.parse(req.body);
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const tenantId = req.user!.tenantId || `tenant-${req.user!.clientId}`;

      const result = ragKnowledge.createQa({
        tenantId,
        companyId,
        question: body.question,
        answer: body.answer,
        department: body.department as any,
        sourceDocumentIds: body.sourceDocumentIds,
        createdBy: req.user!.name,
      });

      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/v1/knowledge/qa
   */
  router.get('/knowledge/qa', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const list = ragKnowledge.listQa(companyId);
      res.json({ qa: list });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------- 3. Audit & Feedback Reviews
  /**
   * GET /api/v1/admin/audit-events
   */
  router.get('/admin/audit-events', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const events = db
        .prepare(`
          SELECT a.audit_id, a.user_id, a.question, a.intent, a.department,
                 a.retrieved_source_ids, a.answer_status, a.confidence, a.feedback,
                 a.model, a.tokens_total, a.cost_inr, a.latency_ms, a.created_at,
                 u.name as user_name, u.email as user_email
          FROM rag_audit_events a
          LEFT JOIN users u ON u.id = a.user_id
          WHERE a.company_id = ?
          ORDER BY a.created_at DESC
          LIMIT 100
        `)
        .all(companyId);

      res.json({ events });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/v1/admin/feedback-reviews
   */
  router.get('/admin/feedback-reviews', auth, (req, res, next) => {
    try {
      const companyId = req.user!.companyId || `company-${req.user!.clientId}`;
      const reviews = db
        .prepare(`
          SELECT m.message_id, m.question, m.answer, m.feedback, m.feedback_comment,
                 m.proposed_correction, m.review_status, m.created_at,
                 u.name as user_name, u.email as user_email
          FROM rag_messages m
          LEFT JOIN users u ON u.id = m.user_id
          WHERE m.company_id = ? AND m.review_status != 'none'
          ORDER BY m.created_at DESC
        `)
        .all(companyId);

      res.json({ reviews });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
