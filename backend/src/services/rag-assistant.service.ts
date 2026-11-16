import crypto from 'node:crypto';
import type { AppConfig } from '../config';
import { AppError } from '../errors';
import type { AuthUser, Db, RagAskResponse, RagCitation, RagDepartment, Role } from '../types';
import { redactSensitive } from './ai-safety.service';
import { RagLiveDataService } from './rag-live-data.service';
import type { ExtractedEntities } from './rag-nlp.service';
import { RagNlpService } from './rag-nlp.service';
import { RagGenerationService } from './rag-generation.service';
import { RagRetrievalService } from './rag-retrieval.service';
import { RagVectorService } from './rag-vector.service';

export interface RagAskOptions {
  question: string;
  conversationId?: string | null;
  departmentHint?: string;
}

/** Roles allowed to see live supplier balances (finance data). */
export const SUPPLIER_BALANCE_ROLES: Role[] = ['management', 'finance'];

function toStringEntities(e: ExtractedEntities): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

const inr = (n: number) => n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

type LiveAnswer = {
  answer: string;
  answerStatus: RagAskResponse['answerStatus'];
  citations: RagCitation[];
  confidence: number;
  clarificationQuestion: string | null;
  model: string;
};

export class RagAssistantService {
  private config: AppConfig;
  private db: Db;
  private nlpService: RagNlpService;
  private vectorService: RagVectorService;
  private retrievalService: RagRetrievalService;
  private liveDataService: RagLiveDataService;
  private generationService: RagGenerationService;

  constructor(config: AppConfig, db: Db) {
    this.config = config;
    this.db = db;
    this.nlpService = new RagNlpService();
    this.vectorService = new RagVectorService(config);
    this.retrievalService = new RagRetrievalService(db, this.vectorService);
    this.liveDataService = new RagLiveDataService(db);
    this.generationService = new RagGenerationService(config);
  }

  /**
   * Main Question-Answering Pipeline for WhizUnik AI RAG Application
   *
   * Flow:
   * 1. Resolve company & tenant strictly from authenticated user (never trust client)
   * 2. Analyze question with NLP (intent, department, entities)
   * 3. If live data requested: query authorized live platform tables
   * 4. Perform tenant-isolated retrieval over company workflows, SOPs & stored Q&A
   * 5. Generate grounded response with citations
   * 6. Save conversation, message & audit log
   */
  async ask(user: AuthUser, opts: RagAskOptions): Promise<RagAskResponse> {
    const question = (opts.question || '').trim();
    if (!question) {
      throw new AppError('INVALID_QUESTION', 400, 'Please enter a question.');
    }
    // Secrets or card numbers typed into a question are never stored as typed.
    const storedQuestion = redactSensitive(question);

    // 1. Resolve trusted tenant scope
    const companyId = user.companyId || `company-${user.clientId}`;
    const tenantId = user.tenantId || `tenant-${user.clientId}`;

    // Get company details
    const companyRow = this.db
      .prepare('SELECT name, industry FROM clients WHERE id = ?')
      .get(user.clientId) as { name: string; industry?: string } | undefined;
    const companyName = companyRow?.name || 'WhizUnik Enterprise';

    // 2. Question analysis using NLP
    const nlp = this.nlpService.analyze(question, opts.departmentHint);

    const entities = toStringEntities(nlp.entities);

    let conversationId = opts.conversationId;
    if (conversationId) {
      // Only the user's own conversation in their own company can be continued.
      const owned = this.db
        .prepare('SELECT 1 FROM rag_conversations WHERE conversation_id = ? AND user_id = ? AND company_id = ?')
        .get(conversationId, user.id, companyId);
      if (!owned) throw new AppError('NOT_FOUND', 404, 'Conversation not found. Start a new chat.');
    } else {
      conversationId = `conv-${crypto.randomUUID().slice(0, 8)}`;
      this.db
        .prepare(`
          INSERT INTO rag_conversations (conversation_id, tenant_id, company_id, user_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `)
        .run(conversationId, tenantId, companyId, user.id, storedQuestion.slice(0, 60));
    }

    // 3. Live platform data (e.g. supplier balance): authorised roles only, read from the live ledger.
    if (nlp.intent === 'supplier_balance' && nlp.entities.supplier) {
      const started = Date.now();
      const live = this.answerSupplierBalance(user, String(nlp.entities.supplier), nlp.entities.period ? String(nlp.entities.period) : undefined);
      if (live) {
        const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;
        this.recordInteraction({
          messageId,
          conversationId,
          tenantId,
          companyId,
          userId: user.id,
          question: storedQuestion,
          answer: live.answer,
          intent: nlp.intent,
          department: nlp.department,
          retrievedSourceIds: live.citations.map((c) => c.documentId),
          confidence: live.confidence,
          answerStatus: live.answerStatus,
          clarificationQuestion: live.clarificationQuestion,
          model: live.model,
          inputTokens: 0,
          outputTokens: 0,
          costInr: 0,
          latencyMs: Date.now() - started,
        });
        return {
          answer: live.answer,
          answerStatus: live.answerStatus,
          citations: live.citations,
          confidence: live.confidence,
          intent: nlp.intent,
          department: nlp.department,
          entities,
          clarificationQuestion: live.clarificationQuestion,
          conversationId,
          messageId,
          model: live.model,
          usage: { inputTokens: 0, outputTokens: 0, costInr: 0 },
        };
      }
    }

    // 4. Tenant-isolated RAG retrieval
    const retrieval = await this.retrievalService.retrieve(tenantId, companyId, question, nlp);

    // 5. Generate grounded response
    const gen = await this.generationService.generate(question, nlp, retrieval, companyName);
    const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;

    // 6. Record interaction in conversation messages & audit events
    this.recordInteraction({
      messageId,
      conversationId,
      tenantId,
      companyId,
      userId: user.id,
      question: storedQuestion,
      answer: gen.answer,
      intent: nlp.intent,
      department: nlp.department,
      retrievedSourceIds: gen.citations.map((c) => c.documentId),
      confidence: gen.confidence,
      answerStatus: gen.answerStatus,
      clarificationQuestion: gen.clarificationQuestion,
      model: gen.model,
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      costInr: gen.costInr,
      latencyMs: gen.latencyMs,
    });

    return {
      answer: gen.answer,
      answerStatus: gen.answerStatus,
      citations: gen.citations,
      confidence: gen.confidence,
      intent: nlp.intent,
      department: nlp.department,
      entities,
      clarificationQuestion: gen.clarificationQuestion,
      conversationId,
      messageId,
      model: gen.model,
      usage: {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        costInr: gen.costInr,
      },
    };
  }

  /**
   * Submit feedback on an answer (helpful / not helpful, with optional comment and proposed correction)
   */
  submitFeedback(opts: {
    messageId: string;
    userId: number;
    feedback: 'helpful' | 'not_helpful';
    comment?: string;
    proposedCorrection?: string;
  }) {
    // Users can only rate their own answers (which also keeps feedback inside their company).
    const msg = this.db
      .prepare('SELECT message_id, conversation_id, tenant_id, company_id FROM rag_messages WHERE message_id = ? AND user_id = ?')
      .get(opts.messageId, opts.userId) as { message_id: string; conversation_id: string; tenant_id: string; company_id: string } | undefined;

    if (!msg) {
      throw new AppError('NOT_FOUND', 404, 'Answer not found.');
    }

    const reviewStatus = opts.proposedCorrection ? 'pending' : 'none';

    this.db
      .prepare(`
        UPDATE rag_messages
        SET feedback = ?, feedback_comment = ?, proposed_correction = ?, review_status = ?
        WHERE message_id = ?
      `)
      .run(
        opts.feedback,
        opts.comment ? redactSensitive(opts.comment) : null,
        opts.proposedCorrection ? redactSensitive(opts.proposedCorrection) : null,
        reviewStatus,
        opts.messageId,
      );

    // Update corresponding audit event
    this.db
      .prepare(`UPDATE rag_audit_events SET feedback = ? WHERE audit_id = ?`)
      .run(opts.feedback, opts.messageId);

    return { success: true, messageId: opts.messageId, reviewStatus };
  }

  /**
   * Live supplier balance from the company's own accounts-payable records (unpaid supplier bills).
   * Returns null when the supplier is unknown, so the question falls through to normal retrieval.
   */
  private answerSupplierBalance(user: AuthUser, supplierQuery: string, period?: string): LiveAnswer | null {
    const ledger: RagCitation = {
      documentId: 'live-finance-ap',
      title: 'Accounts payable — supplier bills (live data)',
      department: 'Finance',
      version: 1,
      section: 'Supplier balances',
    };
    if (!SUPPLIER_BALANCE_ROLES.includes(user.role)) {
      return {
        answer: 'Supplier balances are finance data and are available to the Finance and Management roles only. Please ask your Finance team.',
        answerStatus: 'insufficient_evidence',
        citations: [],
        confidence: 0,
        clarificationQuestion: null,
        model: 'rag-permissions',
      };
    }
    const result = this.liveDataService.getSupplierOutstanding(user.clientId, supplierQuery, { period });
    if (result.kind === 'not_found') return null;
    if (result.kind === 'ambiguous') {
      const q = `Which supplier do you mean: ${result.candidates.join(', ')}?`;
      return { answer: q, answerStatus: 'clarification_needed', citations: [], confidence: 0, clarificationQuestion: q, model: 'rag-classifier' };
    }
    const r = result.data;
    const asOf = new Date(r.asOf).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const scope = r.periodLabel ? ` for bills due ${r.periodLabel}` : '';
    let answer: string;
    if (r.bills.length === 0) {
      answer = `There are no unpaid bills from **${r.supplierName}**${scope} (live data as of ${asOf}).`;
      if (r.otherOpenTotalInr > 0) answer += `\n\nOther unpaid bills from this supplier (outside that period): ${inr(r.otherOpenTotalInr)}.`;
    } else {
      answer =
        `You owe **${r.supplierName}** **${inr(r.totalDueInr)}**${scope}, across ${r.bills.length} unpaid bill(s) (live data as of ${asOf}):\n\n` +
        r.bills
          .map((b) => `- **${b.billNumber}** — due ${b.dueDate}: ${inr(b.outstandingInr)} outstanding${b.paidInr > 0 ? ` (of ${inr(b.amountInr)}, ${inr(b.paidInr)} already paid)` : ''}${b.overdue ? ' — overdue' : ''}`)
          .join('\n');
      if (r.otherOpenTotalInr > 0) answer += `\n\nOther unpaid bills from this supplier (outside that period): ${inr(r.otherOpenTotalInr)}.`;
    }
    return {
      answer,
      answerStatus: 'grounded',
      citations: [{ ...ledger, excerpt: `Unpaid supplier bills for ${r.supplierName}${scope}, read live on ${asOf}.` }],
      confidence: 1,
      clarificationQuestion: null,
      model: 'whizunik-live-ledger',
    };
  }

  // ------------------------------------------------------------------ feedback review (Knowledge Admin)

  /** Corrections waiting for review, plus already decided ones, for one company. */
  listFeedbackReviews(companyId: string) {
    return this.db
      .prepare(`
        SELECT m.message_id, m.question, m.answer, m.department, m.feedback, m.feedback_comment,
               m.proposed_correction, m.review_status, m.created_at,
               u.name as user_name, u.email as user_email
        FROM rag_messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.review_status != 'none'
        ORDER BY CASE m.review_status WHEN 'pending' THEN 0 ELSE 1 END, m.created_at DESC
      `)
      .all(companyId);
  }

  private pendingReview(messageId: string, companyId: string) {
    const msg = this.db
      .prepare(`SELECT message_id, tenant_id, company_id, question, department, proposed_correction, retrieved_source_ids, review_status
                FROM rag_messages WHERE message_id = ? AND company_id = ?`)
      .get(messageId, companyId) as
      | { message_id: string; tenant_id: string; company_id: string; question: string; department: string | null; proposed_correction: string | null; retrieved_source_ids: string; review_status: string }
      | undefined;
    if (!msg || msg.review_status === 'none') throw new AppError('NOT_FOUND', 404, 'Review item not found.');
    if (msg.review_status !== 'pending') throw new AppError('CONFLICT', 409, `This correction was already ${msg.review_status}.`);
    return msg;
  }

  /**
   * Approve a user's correction: it becomes an approved stored answer for THIS company only (spec §14).
   * The reviewer may edit the question/answer wording before approving.
   */
  approveFeedbackReview(
    messageId: string,
    companyId: string,
    reviewer: string,
    edits: { question?: string; answer?: string; department?: RagDepartment },
    createQa: (qa: { tenantId: string; companyId: string; question: string; answer: string; department: RagDepartment; sourceDocumentIds: string[]; createdBy: string }) => { responseId: string },
  ) {
    const msg = this.pendingReview(messageId, companyId);
    const answer = (edits.answer ?? msg.proposed_correction ?? '').trim();
    if (answer.length < 5) throw new AppError('INVALID_REQUEST', 400, 'The approved answer is empty. Edit it before approving.');
    let sources: string[] = [];
    try {
      const parsed = JSON.parse(msg.retrieved_source_ids || '[]');
      // Only document ids (not stored answers or live-data markers) count as sources of the new answer.
      if (Array.isArray(parsed)) sources = [...new Set(parsed.filter((s) => typeof s === 'string' && s.startsWith('doc-')))];
    } catch {
      /* none */
    }
    const run = this.db.transaction(() => {
      const created = createQa({
        tenantId: msg.tenant_id,
        companyId: msg.company_id,
        question: (edits.question ?? msg.question).trim(),
        answer,
        department: (edits.department ?? (msg.department as RagDepartment | null) ?? 'General platform help') as RagDepartment,
        sourceDocumentIds: sources,
        createdBy: reviewer,
      });
      this.db.prepare(`UPDATE rag_messages SET review_status = 'approved' WHERE message_id = ?`).run(messageId);
      return created;
    });
    const created = run();
    return { success: true, messageId, reviewStatus: 'approved', responseId: created.responseId };
  }

  rejectFeedbackReview(messageId: string, companyId: string) {
    this.pendingReview(messageId, companyId);
    this.db.prepare(`UPDATE rag_messages SET review_status = 'rejected' WHERE message_id = ?`).run(messageId);
    return { success: true, messageId, reviewStatus: 'rejected' };
  }

  /**
   * List conversations for a user
   */
  getConversations(userId: number, limit = 20) {
    return this.db
      .prepare(`
        SELECT conversation_id, title, created_at, updated_at
        FROM rag_conversations
        WHERE user_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(userId, limit);
  }

  /**
   * Get messages for a conversation
   */
  getConversationMessages(conversationId: string, userId: number) {
    return this.db
      .prepare(`
        SELECT message_id, question, answer, intent, department, retrieved_source_ids,
               confidence, answer_status, clarification_question, model, feedback, created_at
        FROM rag_messages
        WHERE conversation_id = ? AND user_id = ?
        ORDER BY created_at ASC
      `)
      .all(conversationId, userId);
  }

  private recordInteraction(data: {
    messageId: string;
    conversationId: string;
    tenantId: string;
    companyId: string;
    userId: number;
    question: string;
    answer: string;
    intent: string;
    department: string;
    retrievedSourceIds: string[];
    confidence: number;
    answerStatus: string;
    clarificationQuestion?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costInr: number;
    latencyMs: number;
  }) {
    const sourceIdsJson = JSON.stringify(data.retrievedSourceIds);

    // 1. Insert message
    this.db
      .prepare(`
        INSERT INTO rag_messages (
          message_id, conversation_id, tenant_id, company_id, user_id,
          question, answer, intent, department, retrieved_source_ids,
          confidence, answer_status, clarification_question, model,
          input_tokens, output_tokens, cost_inr, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .run(
        data.messageId,
        data.conversationId,
        data.tenantId,
        data.companyId,
        data.userId,
        data.question,
        data.answer,
        data.intent,
        data.department,
        sourceIdsJson,
        data.confidence,
        data.answerStatus,
        data.clarificationQuestion || null,
        data.model,
        data.inputTokens,
        data.outputTokens,
        data.costInr,
        data.latencyMs,
      );

    // 2. Insert audit event
    this.db
      .prepare(`
        INSERT INTO rag_audit_events (
          audit_id, tenant_id, company_id, user_id, question, intent,
          department, retrieved_source_ids, answer_status, confidence,
          model, tokens_total, cost_inr, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .run(
        data.messageId,
        data.tenantId,
        data.companyId,
        data.userId,
        data.question,
        data.intent,
        data.department,
        sourceIdsJson,
        data.answerStatus,
        data.confidence,
        data.model,
        data.inputTokens + data.outputTokens,
        data.costInr,
        data.latencyMs,
      );

    // 3. Update conversation updated_at
    this.db
      .prepare(`UPDATE rag_conversations SET updated_at = datetime('now') WHERE conversation_id = ?`)
      .run(data.conversationId);
  }
}

